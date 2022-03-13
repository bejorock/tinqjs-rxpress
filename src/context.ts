import { Request, Response } from "express";
import { Observable, of, Subject } from "rxjs";
import { Stream } from "stream";
import * as R from "ramda";
import { Router } from "express";
import { Logger } from "./logger";

const logger = Logger.logger;
const tokensPattern = new RegExp(/\:(.+)/, "g");

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

const attach = (route: Route) => (req: Request, res: Response) => {
  const ctx = applyContext(req);

  route(of(ctx)).subscribe({
    next(output) {
      if (output instanceof Observable) {
        // send as chunk
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Transfer-Encoding": "chunked",
        });

        output.subscribe({
          next(v) {
            res.write(
              Buffer.from(JSON.stringify(v), "utf-8").toString("base64") + "\n"
            );
          },
          error(err) {
            logger.error(err);
            res.write("error");
          },
          complete() {
            res.write(
              Buffer.from(JSON.stringify("done"), "utf-8").toString("base64")
            );
            res.end();
          },
        });
      } else res.status(200).send(output);
    },

    error(err) {
      logger.error(err);
      logger.debug(JSON.stringify(err, null, 4));

      if (!res.headersSent)
        res.status(500).send(`${err.message}, reason: \n\t\t${err.stack}`);
    },
  });
};

const sortRoutes = (a: string, b: string) => {
  const aTokens = a.split("/");
  const bTokens = b.split("/");

  const result = (() => {
    // if (aTokens.length != bTokens.length)
    // return bTokens.length - aTokens.length;
    for (let i = 0; i < aTokens.length; i++) {
      if (aTokens[i] && !bTokens[i]) return -1;
      else if (!aTokens[i] && bTokens[i]) return 1;

      if (aTokens[i] !== bTokens[i]) {
        if (tokensPattern.test(aTokens[i]) && !tokensPattern.test(bTokens[i]))
          return 1;
        else if (
          !tokensPattern.test(aTokens[i]) &&
          tokensPattern.test(bTokens[i])
        )
          return -1;
        else if (
          tokensPattern.test(aTokens[i]) &&
          tokensPattern.test(bTokens[i])
        )
          return bTokens[i].length - aTokens[i].length;
      }
    }

    return 0;
  })();

  // console.log(a, b, result);
  return result;
};

const normalizePath = (routePath: string) => {
  const pathTokens = routePath
    .split("_")
    .map((p) => (p.startsWith("$") ? ":" + p.substring(1) : p));
  const [method, ...parts] = pathTokens;
  return { routePath: "/" + parts.join("/"), method };
};

export const attachRouter = (routes: { [key: string]: Route }) => {
  const router: Record<string, any> = Router();
  const modules = Object.keys(routes)
    .map((k) => ({
      ...normalizePath(k),
      route: routes[k],
    }))
    .sort((a, b) => sortRoutes(a.routePath, b.routePath));

  for (let m of modules) router[m.method](m.routePath, attach(m.route));

  return router;
};
