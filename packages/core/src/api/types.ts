/**
 * Type plumbing between the generated `paths` interface (openapi-typescript
 * output in ../generated/openapi.ts) and the thin client in ./client.ts.
 *
 * Nothing here names an operation. Every path, method, parameter and
 * body shape is read from `paths`, so the client is only as wide, and
 * only as narrow, as the snapshot it was generated from.
 */

import type { paths } from "../generated/openapi.js";
import type { CallOptions } from "../types.js";

export type ApiPaths = paths;
export type ApiPath = keyof paths & string;

/** The HTTP methods the served document uses. Others compile to `never`. */
export type ApiMethod = "get" | "put" | "post" | "delete" | "patch";

/**
 * The operation declared for `method` on `path`. openapi-typescript
 * declares every method on every path and marks the absent ones
 * `?: never`, so an absent operation reads as `undefined` here and
 * `NonNullable` turns it into `never`.
 */
export type ApiOperation<P extends ApiPath, M extends ApiMethod> = NonNullable<paths[P][M]>;

/** The paths that declare `method`. */
export type ApiPathsFor<M extends ApiMethod> = {
  [P in ApiPath]: [ApiOperation<P, M>] extends [never] ? never : P;
}[ApiPath];

/**
 * One generated table row per operation. `method`/`path` pairs are the
 * declared ones only; the `satisfies` in the generated table refuses a
 * row the types do not know.
 */
export type ApiOperationRef = {
  [P in ApiPath]: {
    [M in ApiMethod]: [ApiOperation<P, M>] extends [never]
      ? never
      : { method: M; path: P; body: string | null; accept: string | null };
  }[ApiMethod];
}[ApiPath];

/* ── Request side ─────────────────────────────────────────────────── */

type Get<T, K extends string> = K extends keyof T ? T[K] : never;

type ParametersOf<Op> = Op extends { parameters: infer Pm } ? Pm : {};

/** The declared value of a parameter location, `never` when the operation has none. */
type ParamValue<Op, K extends "path" | "query" | "header"> = Exclude<
  Get<ParametersOf<Op>, K>,
  undefined
>;

type IsRequiredKey<T, K extends string> = K extends keyof T
  ? {} extends Pick<T, K>
    ? false
    : true
  : false;

type Field<K extends string, V, Required extends boolean> = [V] extends [never]
  ? { [k in K]?: never }
  : Required extends true
    ? { [k in K]: V }
    : { [k in K]?: V };

/**
 * The request body the operation accepts, whatever its content type; the
 * generated operation table says how to serialise it. `never` when the
 * operation takes no body.
 */
export type ApiRequestBody<Op> = Op extends { requestBody?: infer RB }
  ? [NonNullable<RB>] extends [never]
    ? never
    : NonNullable<RB> extends { content: infer C }
      ? C[keyof C]
      : never
  : never;

/**
 * Options for one call: path/query/header parameters and the body as the
 * document declares them (required when the document says so), plus the
 * SDK-wide per-call `timeout`/`signal`.
 */
export type ApiRequestOptions<Op> = CallOptions &
  Field<"path", ParamValue<Op, "path">, IsRequiredKey<ParametersOf<Op>, "path">> &
  Field<"query", ParamValue<Op, "query">, IsRequiredKey<ParametersOf<Op>, "query">> &
  Field<"header", ParamValue<Op, "header">, IsRequiredKey<ParametersOf<Op>, "header">> &
  Field<"body", ApiRequestBody<Op>, false>;

/** `[opts?]` when every option is optional, `[opts]` otherwise. */
export type ApiRequestArgs<Op> = {} extends ApiRequestOptions<Op>
  ? [options?: ApiRequestOptions<Op>]
  : [options: ApiRequestOptions<Op>];

/* ── Response side ────────────────────────────────────────────────── */

type ResponsesOf<Op> = Op extends { responses: infer R } ? R : {};

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;

/**
 * What the client hands back for a documented content map: the JSON
 * shape for `application/json`, the raw `Response` for `text/event-stream`
 * (the body is a stream, not a value), the text for anything else.
 */
type ContentData<C> = C extends { "application/json": infer J }
  ? J
  : C extends { "text/event-stream": unknown }
    ? Response
    : C extends { "text/html": unknown }
      ? string
      : C[keyof C];

type ResponseData<R> = R extends { content?: infer C }
  ? [NonNullable<C>] extends [never]
    ? undefined
    : ContentData<NonNullable<C>>
  : unknown;

/**
 * Every documented status of an operation as a discriminated union on
 * `status`. A status the document does not list arrives at runtime in
 * the same shape with `data: unknown`; the type only knows the document.
 */
export type ApiResponse<Op> = {
  [S in keyof ResponsesOf<Op>]: {
    status: S;
    ok: S extends SuccessStatus ? true : false;
    data: ResponseData<ResponsesOf<Op>[S]>;
    response: Response;
  };
}[keyof ResponsesOf<Op>];

/** The data of the documented 2xx responses. */
export type ApiSuccess<Op> = Extract<ApiResponse<Op>, { ok: true }>["data"];
