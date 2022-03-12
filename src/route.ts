import * as R from "ramda";
import { Request, Response, Router } from "express";
import { Observable, of, Subject } from "rxjs";
import stream from "stream";

import { Logger } from "./logger";
import { IHttpContext } from "./types";

const tokensPattern = new RegExp(/\:(.+)/, "g");

export interface IHandler {
  (
    context: Observable<IHttpContext>,
    res: Response,
    next?: Function
  ): Observable<any>;
}

export interface Route {
  (context: Observable<IHttpContext>): Observable<any>;
}

export interface RouteAttach {
  (routePath: string, route: Route): void;
}

export interface RouteContext {
  get: RouteAttach;
  post: RouteAttach;
  put: RouteAttach;
  patch: RouteAttach;
  delete: RouteAttach;
}

export const r =
  (handler: IHandler) =>
  (context: IHttpContext) =>
  (res: Response, next: Function) => {
    handler(of(context), res, next).subscribe({
      next(item) {
        if (!res.headersSent) res.status(200).send(item);
      },
      error(err) {
        Logger.logger.error(err);
        Logger.logger.debug(JSON.stringify(err, null, 4));

        if (!res.headersSent)
          res.status(500).send(`${err.message}, reason: \n\t\t${err.stack}`);
      },
    });
  };

const applyContext: (req: Request) => IHttpContext = R.applySpec({
  headers: R.prop("headers"),
  query: R.prop("query"),
  params: R.prop("params"),
  body: R.prop("body"),
  req: R.identity,
});

export const streamAsChunk = (source: Observable<any>) =>
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
      } else if (output instanceof stream) output.pipe(res);
      else res.status(200).send(output);
    },

    error(err) {
      Logger.logger.error(err);
      Logger.logger.debug(JSON.stringify(err, null, 4));

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

  for (let m of modules) router[m.method as any](m.routePath, attach(m.route));

  return router;
};
