import { Request, Response } from "express";
import {
  map,
  Observable,
  of,
  OperatorFunction,
  Subject,
  switchMap,
} from "rxjs";
import { Stream } from "stream";
import * as R from "ramda";

import { Logger } from "./logger";

export declare type IHttpParam = {
  from: "query" | "path" | "body";
  type: "string" | "number" | "boolean" | "array" | "object" | "blob";
  required?: boolean;
  parser?: (value: any) => any;
};

export declare type IHttpParams = {
  [key: string]: IHttpParam;
};

export declare type IHttpContext = {
  headers: any;
  query: any;
  params: any;
  body: any;
  req: Partial<Request> & Partial<{ [key: string]: any }>;
};

export declare type IHttpIncoming = {
  ctx: IHttpContext;
  res: Response;
};

export declare type IHttpResponse = {
  (res: Response): void;
};

export const httpResponse =
  (content: any): IHttpResponse =>
  (res: Response) =>
    res.status(200).send(content);

export const chunkResponse =
  (source: Observable<any>): IHttpResponse =>
  (res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    });

    source.subscribe({
      next(v) {
        res.write(
          Buffer.from(JSON.stringify(v), "utf-8").toString("base64") + "\n"
        );
      },
      error(err) {
        Logger.logger.error(err);
        res.write("error");
      },
      complete() {
        res.write(
          Buffer.from(JSON.stringify("done"), "utf-8").toString("base64")
        );
        res.end();
      },
    });
  };

export const streamResponse =
  (source: Stream): IHttpResponse =>
  (res: Response) =>
    source.pipe(res);

const incoming = new Subject<IHttpIncoming>();

export const inQueue$ = incoming.asObservable();
export const handleIncoming = (context: IHttpIncoming) =>
  incoming.next(context);

const handleResponse =
  (res: Response) => (source: Observable<IHttpResponse>) => {
    source.subscribe({
      next(handler) {
        if (res.headersSent) return;

        try {
          handler(res);
        } catch (e) {
          Logger.logger.error(e);
          res.status(500).send(e);
        }
      },

      error(err) {
        Logger.logger.error(err);
        res.status(500).send(err);
      },
    });
  };

export const route = R.compose((fn: OperatorFunction<any, IHttpResponse>) => {
  inQueue$.subscribe({
    next({ ctx, res }) {
      const handler = handleResponse(res);
      handler(fn(of(ctx)));
    },

    error(err) {
      Logger.logger.error(err);
    },
  });
}, R.pipe);

export interface Route {
  (context: Observable<IHttpContext>): Observable<any>;
}

const applyContext: (req: Request) => IHttpContext = R.applySpec({
  headers: R.prop("headers"),
  query: R.prop("query"),
  params: R.prop("params"),
  body: R.prop("body"),
  req: R.identity,
});

export const chunkFromStream = (source: Observable<any>) =>
  new Observable<any>((subs) => {
    const subject = new Subject<any>();

    subs.next(subject.asObservable());

    source.subscribe({
      next: (item) => subject.next(item),
      error: (err) => subject.error(err),
      complete: () => subject.complete(),
    });
  });

export const handleRoute = (req: Request, res: Response) => {
  const ctx = applyContext(req);

  handleIncoming({ ctx, res });
};
