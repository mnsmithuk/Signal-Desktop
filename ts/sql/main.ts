// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { join } from 'path';
import { Worker } from 'worker_threads';
import { format } from 'util';
import { app } from 'electron';

import { strictAssert } from '../util/assert';
import { explodePromise } from '../util/explodePromise';
import type { LoggerType } from '../types/Logging';
import { SqliteErrorKind } from './errors';
import type {
  ServerReadableDirectInterface,
  ServerWritableDirectInterface,
} from './Interface';

const MIN_TRACE_DURATION = 40;

const WORKER_COUNT = 4;

const PAGING_QUERIES = new Set<keyof ServerReadableDirectInterface>([
  'pageMessages',
  'finishPageMessages',
  'getKnownMessageAttachments',
  'finishGetKnownMessageAttachments',
]);

export type InitializeOptions = Readonly<{
  appVersion: string;
  configDir: string;
  key: string;
  logger: LoggerType;
}>;

export type WorkerRequest = Readonly<
  | {
      type: 'init';
      options: Omit<InitializeOptions, 'logger'>;
      isPrimary: boolean;
    }
  | {
      type: 'close' | 'removeDB';
    }
  | {
      type: 'sqlCall:read';
      method: keyof ServerReadableDirectInterface;
      args: ReadonlyArray<unknown>;
    }
  | {
      type: 'sqlCall:write';
      method: keyof ServerWritableDirectInterface;
      args: ReadonlyArray<unknown>;
    }
>;

export type WrappedWorkerRequest = Readonly<{
  seq: number;
  request: WorkerRequest;
}>;

export type WrappedWorkerLogEntry = Readonly<{
  type: 'log';
  level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  args: ReadonlyArray<unknown>;
}>;

export type WrappedWorkerResponse =
  | Readonly<{
      type: 'response';
      seq: number;
      error: string | undefined;
      errorKind: SqliteErrorKind | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: any;
    }>
  | WrappedWorkerLogEntry;

type PromisePair<T> = {
  resolve: (response: T) => void;
  reject: (error: Error) => void;
};

type KnownErrorResolverType = Readonly<{
  kind: SqliteErrorKind;
  resolve: (err: Error) => void;
}>;

type CreateWorkerResultType = Readonly<{
  worker: Worker;
  onExit: Promise<void>;
}>;

type PoolEntry = {
  readonly worker: Worker;
  load: number;
};

export class MainSQL {
  private readonly pool = new Array<PoolEntry>();

  private pauseWaiters: Array<() => void> | undefined;

  private isReady = false;

  private onReady: Promise<void> | undefined;

  private readonly onExit: Promise<unknown>;

  // Promise resolve callbacks for corruption and readonly errors.
  private errorResolvers = new Array<KnownErrorResolverType>();

  private seq = 0;

  private logger?: LoggerType;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onResponse = new Map<number, PromisePair<any>>();

  private shouldTimeQueries = false;

  constructor() {
    const exitPromises = new Array<Promise<void>>();
    for (let i = 0; i < WORKER_COUNT; i += 1) {
      const { worker, onExit } = this.createWorker();
      this.pool.push({ worker, load: 0 });

      exitPromises.push(onExit);
    }
    this.onExit = Promise.all(exitPromises);
  }

  public async initialize({
    appVersion,
    configDir,
    key,
    logger,
  }: InitializeOptions): Promise<void> {
    if (this.isReady || this.onReady) {
      throw new Error('Already initialized');
    }

    this.shouldTimeQueries = Boolean(process.env.TIME_QUERIES);

    this.logger = logger;

    this.onReady = (async () => {
      const primary = this.pool[0];
      const rest = this.pool.slice(1);

      await this.send(primary, {
        type: 'init',
        options: { appVersion, configDir, key },
        isPrimary: true,
      });

      await Promise.all(
        rest.map(worker =>
          this.send(worker, {
            type: 'init',
            options: { appVersion, configDir, key },
            isPrimary: false,
          })
        )
      );
    })();

    await this.onReady;

    this.onReady = undefined;
    this.isReady = true;
  }

  public pauseWriteAccess(): void {
    strictAssert(this.pauseWaiters == null, 'Already paused');

    this.pauseWaiters = [];
  }

  public resumeWriteAccess(): void {
    const { pauseWaiters } = this;
    strictAssert(pauseWaiters != null, 'Not paused');
    this.pauseWaiters = undefined;

    for (const waiter of pauseWaiters) {
      waiter();
    }
  }

  public whenCorrupted(): Promise<Error> {
    const { promise, resolve } = explodePromise<Error>();
    this.errorResolvers.push({ kind: SqliteErrorKind.Corrupted, resolve });
    return promise;
  }

  public whenReadonly(): Promise<Error> {
    const { promise, resolve } = explodePromise<Error>();
    this.errorResolvers.push({ kind: SqliteErrorKind.Readonly, resolve });
    return promise;
  }

  public async close(): Promise<void> {
    if (!this.isReady) {
      throw new Error('Not initialized');
    }

    await this.terminate({ type: 'close' });
    await this.onExit;
  }

  public async removeDB(): Promise<void> {
    await this.terminate({ type: 'removeDB' });
  }

  public async sqlRead<Method extends keyof ServerReadableDirectInterface>(
    method: Method,
    ...args: Parameters<ServerReadableDirectInterface[Method]>
  ): Promise<ReturnType<ServerReadableDirectInterface[Method]>> {
    type SqlCallResult = Readonly<{
      result: ReturnType<ServerReadableDirectInterface[Method]>;
      duration: number;
    }>;

    // pageMessages runs over several queries and needs to have access to
    // the same temporary table.
    const isPaging = PAGING_QUERIES.has(method);

    const entry = isPaging ? this.pool.at(-1) : this.getWorker();
    strictAssert(entry != null, 'Must have a pool entry');

    const { result, duration } = await this.send<SqlCallResult>(entry, {
      type: 'sqlCall:read',
      method,
      args,
    });

    this.traceDuration(method, duration);

    return result;
  }

  public async sqlWrite<Method extends keyof ServerWritableDirectInterface>(
    method: Method,
    ...args: Parameters<ServerWritableDirectInterface[Method]>
  ): Promise<ReturnType<ServerWritableDirectInterface[Method]>> {
    type Result = ReturnType<ServerWritableDirectInterface[Method]>;
    type SqlCallResult = Readonly<{
      result: Result;
      duration: number;
    }>;

    while (this.pauseWaiters != null) {
      const { promise, resolve } = explodePromise<void>();
      this.pauseWaiters.push(resolve);
      // eslint-disable-next-line no-await-in-loop
      await promise;
    }

    // Special case since we need to broadcast this to every pool entry.
    if (method === 'removeDB') {
      return (await this.removeDB()) as Result;
    }

    const primary = this.pool[0];

    const { result, duration } = await this.send<SqlCallResult>(primary, {
      type: 'sqlCall:write',
      method,
      args,
    });

    this.traceDuration(method, duration);

    return result;
  }

  private async send<Response>(
    entry: PoolEntry,
    request: WorkerRequest
  ): Promise<Response> {
    if (request.type === 'sqlCall:read' || request.type === 'sqlCall:write') {
      if (this.onReady) {
        await this.onReady;
      }

      if (!this.isReady) {
        throw new Error('Not initialized');
      }
    }

    const { seq } = this;
    // eslint-disable-next-line no-bitwise
    this.seq = (this.seq + 1) >>> 0;

    const { promise: result, resolve, reject } = explodePromise<Response>();
    this.onResponse.set(seq, { resolve, reject });

    const wrappedRequest: WrappedWorkerRequest = {
      seq,
      request,
    };
    entry.worker.postMessage(wrappedRequest);

    try {
      // eslint-disable-next-line no-param-reassign
      entry.load += 1;
      return await result;
    } finally {
      // eslint-disable-next-line no-param-reassign
      entry.load -= 1;
    }
  }

  private async terminate(request: WorkerRequest): Promise<void> {
    const primary = this.pool[0];
    const rest = this.pool.slice(1);

    // Terminate non-primary workers first
    await Promise.all(rest.map(worker => this.send(worker, request)));

    // Primary last
    await this.send(primary, request);
  }

  private onError(errorKind: SqliteErrorKind, error: Error): void {
    if (errorKind === SqliteErrorKind.Unknown) {
      return;
    }

    const resolvers = new Array<(error: Error) => void>();
    this.errorResolvers = this.errorResolvers.filter(entry => {
      if (entry.kind === errorKind) {
        resolvers.push(entry.resolve);
        return false;
      }
      return true;
    });

    for (const resolve of resolvers) {
      resolve(error);
    }
  }

  private traceDuration(method: string, duration: number): void {
    if (this.shouldTimeQueries && !app.isPackaged) {
      const twoDecimals = Math.round(100 * duration) / 100;
      this.logger?.info(`MainSQL query: ${method}, duration=${twoDecimals}ms`);
    }
    if (duration > MIN_TRACE_DURATION) {
      strictAssert(this.logger !== undefined, 'Logger not initialized');
      this.logger.info(
        `MainSQL: slow query ${method} duration=${Math.round(duration)}ms`
      );
    }
  }

  private createWorker(): CreateWorkerResultType {
    const scriptPath = join(app.getAppPath(), 'ts', 'sql', 'mainWorker.js');

    const worker = new Worker(scriptPath);

    worker.on('message', (wrappedResponse: WrappedWorkerResponse) => {
      if (wrappedResponse.type === 'log') {
        const { level, args } = wrappedResponse;
        strictAssert(this.logger !== undefined, 'Logger not initialized');
        this.logger[level](`MainSQL: ${format(...args)}`);
        return;
      }

      const { seq, error, errorKind, response } = wrappedResponse;

      const pair = this.onResponse.get(seq);
      this.onResponse.delete(seq);
      if (!pair) {
        throw new Error(`Unexpected worker response with seq: ${seq}`);
      }

      if (error) {
        const errorObj = new Error(error);
        this.onError(errorKind ?? SqliteErrorKind.Unknown, errorObj);

        pair.reject(errorObj);
      } else {
        pair.resolve(response);
      }
    });

    const { promise: onExit, resolve: resolveOnExit } = explodePromise<void>();
    worker.once('exit', resolveOnExit);

    return { worker, onExit };
  }

  // Find first pool entry with minimal load
  private getWorker(): PoolEntry {
    let min = this.pool[0];
    for (const entry of this.pool) {
      if (min && min.load < entry.load) {
        continue;
      }

      min = entry;
    }
    return min;
  }
}
