var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/hono/dist/http-exception.js
var HTTPException = class extends Error {
  static {
    __name(this, "HTTPException");
  }
  res;
  status;
  /**
  * Creates an instance of `HTTPException`.
  * @param status - HTTP status code for the exception. Defaults to 500.
  * @param options - Additional options for the exception.
  */
  constructor(status = 500, options) {
    super(options?.message, { cause: options?.cause });
    this.res = options?.res;
    this.status = status;
  }
  /**
  * Returns the response object associated with the exception.
  * If a response object is not provided, a new response is created with the error message and status code.
  * @returns The response object.
  */
  getResponse() {
    if (this.res) return new Response(this.res.body, {
      status: this.status,
      headers: this.res.headers
    });
    return new Response(this.message, { status: this.status });
  }
};

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/buffer.js
var bufferToFormData = /* @__PURE__ */ __name((arrayBuffer, contentType) => {
  return new Response(arrayBuffer, { headers: { "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase()) } }).formData();
}, "bufferToFormData");

// node_modules/hono/dist/utils/body.js
var MAX_NESTED_OBJECTS = 1e4;
var isRawRequest = /* @__PURE__ */ __name((request) => "headers" in request, "isRawRequest");
var parseBody = /* @__PURE__ */ __name(async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const mediaType = (isRawRequest(request) ? request.headers : request.raw.headers).get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") return parseFormData(request, {
    all,
    dot
  });
  return {};
}, "parseBody");
async function parseFormData(request, options) {
  if (!isRawRequest(request) && request.bodyCache.formData) return convertFormDataToBodyData(await request.bodyCache.formData, options);
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const arrayBuffer = await request.arrayBuffer();
  const formDataPromise = bufferToFormData(arrayBuffer, headers.get("Content-Type") || "");
  if (!isRawRequest(request)) request.bodyCache.formData = formDataPromise;
  const formData = await formDataPromise;
  if (formData) return convertFormDataToBodyData(formData, options);
  return {};
}
__name(parseFormData, "parseFormData");
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  const nestingState = { count: 0 };
  formData.forEach((value, key) => {
    if (!(options.all || key.endsWith("[]"))) form[key] = value;
    else handleParsingAllValues(form, key, value);
  });
  if (options.dot) Object.entries(form).forEach(([key, value]) => {
    if (key.includes(".")) {
      handleParsingNestedValues(form, key, value, nestingState);
      delete form[key];
    }
  });
  return form;
}
__name(convertFormDataToBodyData, "convertFormDataToBodyData");
var handleParsingAllValues = /* @__PURE__ */ __name((form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) form[key].push(value);
    else form[key] = [form[key], value];
  } else if (!key.endsWith("[]")) form[key] = value;
  else form[key] = [value];
}, "handleParsingAllValues");
var handleParsingNestedValues = /* @__PURE__ */ __name((form, key, value, state) => {
  if (/(?:^|\.)__proto__\./.test(key)) return;
  let nestedForm = form;
  const keys = key.split(".", 34);
  if (keys.length > 33) throwNestingLimitExceeded();
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) nestedForm[key2] = value;
    else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        if (state.count++ >= MAX_NESTED_OBJECTS) throwNestingLimitExceeded();
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
}, "handleParsingNestedValues");
var throwNestingLimitExceeded = /* @__PURE__ */ __name(() => {
  throw new Error("Nesting limit exceeded");
}, "throwNestingLimitExceeded");

// node_modules/hono/dist/utils/url.js
var splitPath = /* @__PURE__ */ __name((path) => {
  const paths = path.split("/");
  if (paths[0] === "") paths.shift();
  return paths;
}, "splitPath");
var splitRoutingPath = /* @__PURE__ */ __name((routePath2) => {
  const { groups, path } = extractGroupsFromPath(routePath2);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
}, "splitRoutingPath");
var extractGroupsFromPath = /* @__PURE__ */ __name((path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return {
    groups,
    path
  };
}, "extractGroupsFromPath");
var replaceGroupMarks = /* @__PURE__ */ __name((paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) if (paths[j].includes(mark)) {
      paths[j] = paths[j].replace(mark, groups[i][1]);
      break;
    }
  }
  return paths;
}, "replaceGroupMarks");
var patternCache = {};
var getPattern = /* @__PURE__ */ __name((label, next) => {
  if (label === "*") return "*";
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [
        cacheKey,
        match2[1],
        new RegExp(`^${match2[2]}(?=/${next})`)
      ] : [
        label,
        match2[1],
        new RegExp(`^${match2[2]}$`)
      ];
      else patternCache[cacheKey] = [
        label,
        match2[1],
        true
      ];
    }
    return patternCache[cacheKey];
  }
  return null;
}, "getPattern");
var tryDecode = /* @__PURE__ */ __name((str2, decoder) => {
  try {
    return decoder(str2);
  } catch {
    return str2.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
}, "tryDecode");
var decodeURIWithPreservedPercent = /* @__PURE__ */ __name((value) => decodeURI(value.includes("%25") ? value.replace(/%25/g, "%2525") : value), "decodeURIWithPreservedPercent");
var getPath = /* @__PURE__ */ __name((request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      const decoded = tryDecode(path, decodeURIWithPreservedPercent);
      if (/%(?![0-9A-Fa-f]{2})/.test(path)) {
        const rewritten = new URL("http://localhost");
        rewritten.pathname = decoded.replace(/[\\\t\n\r]/g, encodeURIComponent);
        if (tryDecode(rewritten.pathname, decodeURIWithPreservedPercent) !== decoded) return tryDecode(path.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"), decodeURIWithPreservedPercent);
      }
      return decoded;
    } else if (charCode === 63 || charCode === 35) break;
  }
  return url.slice(start, i);
}, "getPath");
var getPathNoStrict = /* @__PURE__ */ __name((request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
}, "getPathNoStrict");
var mergePath = /* @__PURE__ */ __name((base, sub, ...rest) => {
  if (rest.length) sub = mergePath(sub, ...rest);
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
}, "mergePath");
var checkOptionalParameter = /* @__PURE__ */ __name((path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) return null;
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) basePath += "/" + segment;
    else if (/\:/.test(segment)) {
      if (segment.charCodeAt(segment.length - 1) === 63) {
        if (results.length === 0 && basePath === "") results.push("/");
        else results.push(basePath);
        const optionalSegment = segment.slice(0, -1);
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else basePath += "/" + segment;
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
}, "checkOptionalParameter");
var tryDecodeURIComponent = /* @__PURE__ */ __name((str2) => str2.indexOf("%") !== -1 ? tryDecode(str2, decodeURIComponent_) : str2, "tryDecodeURIComponent");
var _decodeURI = /* @__PURE__ */ __name((value) => {
  if (value.indexOf("+") !== -1) value = value.replace(/\+/g, " ");
  return tryDecodeURIComponent(value);
}, "_decodeURI");
var _getQueryParam = /* @__PURE__ */ __name((url, key, multiple) => {
  const hashIndex = url.indexOf("#", 8);
  if (hashIndex !== -1) url = url.slice(0, hashIndex);
  let encoded;
  if (!multiple && key && !/[%+&=]/.test(key)) {
    const queryIndex = url.indexOf("?", 8);
    let keyIndex2 = queryIndex;
    if (keyIndex2 === -1) return;
    if (!url.startsWith(key, keyIndex2 + 1)) keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61 || trailingKeyCode === 38 || isNaN(trailingKeyCode)) {
        if (keyIndex2 > queryIndex && /(?:^|&)[^=&]*[%+]/.test(url.slice(queryIndex + 1, keyIndex2))) break;
        if (trailingKeyCode === 61) {
          const valueIndex = keyIndex2 + key.length + 2;
          const endIndex = url.indexOf("&", valueIndex);
          return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
        }
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) return;
  }
  const results = /* @__PURE__ */ Object.create(null);
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) valueIndex = -1;
    let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex);
    if (encoded) name = _decodeURI(name);
    keyIndex = nextKeyIndex;
    if (name === "") continue;
    let value;
    if (valueIndex === -1) value = "";
    else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) value = _decodeURI(value);
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) results[name] = [];
      results[name].push(value);
    } else results[name] ??= value;
  }
  return key ? results[key] : results;
}, "_getQueryParam");
var getQueryParam = _getQueryParam;
var getQueryParams = /* @__PURE__ */ __name((url, key) => {
  return _getQueryParam(url, key, true);
}, "getQueryParams");
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var HonoRequest = class {
  static {
    __name(this, "HonoRequest");
  }
  /**
  * `.raw` can get the raw Request object.
  *
  * @see {@link https://hono.dev/docs/api/request#raw}
  *
  * @example
  * ```ts
  * // For Cloudflare Workers
  * app.post('/', async (c) => {
  *   const metadata = c.req.raw.cf?.hostMetadata?
  *   ...
  * })
  * ```
  */
  raw;
  #validatedData;
  #matchResult;
  routeIndex = 0;
  /**
  * `.path` can get the pathname of the request.
  *
  * @see {@link https://hono.dev/docs/api/request#path}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const pathname = c.req.path // `/about/me`
  * })
  * ```
  */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex]?.[1][key];
    const param = this.#getParamValue(paramKey);
    return param && tryDecodeURIComponent(param);
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex]?.[1] ?? {});
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) decoded[key] = tryDecodeURIComponent(value);
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) return this.raw.headers.get(name) ?? void 0;
    const headerData = /* @__PURE__ */ Object.create(null);
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = /* @__PURE__ */ __name((key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) return cachedBody;
    for (const anyCachedKey in bodyCache) return bodyCache[anyCachedKey].then((body) => {
      if (anyCachedKey === "json") body = JSON.stringify(body);
      const contentType = anyCachedKey === "formData" ? void 0 : raw2.headers.get("content-type");
      return new Response(body, { headers: contentType ? { "Content-Type": contentType } : void 0 })[key]();
    });
    return bodyCache[key] = raw2[key]();
  }, "#cachedBody");
  /**
  * `.json()` can parse Request body of type `application/json`
  *
  * @see {@link https://hono.dev/docs/api/request#json}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.json()
  * })
  * ```
  */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
  * `.text()` can parse Request body of type `text/plain`
  *
  * @see {@link https://hono.dev/docs/api/request#text}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.text()
  * })
  * ```
  */
  text() {
    return this.#cachedBody("text");
  }
  /**
  * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
  *
  * @see {@link https://hono.dev/docs/api/request#arraybuffer}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.arrayBuffer()
  * })
  * ```
  */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
  * `.bytes()` parses the request body as a `Uint8Array`.
  *
  * @see {@link https://hono.dev/docs/api/request#bytes}
  *
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.bytes()
  * })
  * ```
  */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
  * Parses the request body as a `Blob`.
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.blob();
  * });
  * ```
  * @see https://hono.dev/docs/api/request#blob
  */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
  * Parses the request body as `FormData`.
  * @example
  * ```ts
  * app.post('/entry', async (c) => {
  *   const body = await c.req.formData();
  * });
  * ```
  * @see https://hono.dev/docs/api/request#formdata
  */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
  * Adds validated data to the request.
  *
  * @param target - The target of the validation.
  * @param data - The validated data to add.
  */
  addValidatedData(target, data) {
    (this.#validatedData ??= {})[target] = data;
  }
  valid(target) {
    return this.#validatedData?.[target];
  }
  /**
  * `.url` can get the request url strings.
  *
  * @see {@link https://hono.dev/docs/api/request#url}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const url = c.req.url // `http://localhost:8787/about/me`
  *   ...
  * })
  * ```
  */
  get url() {
    return this.raw.url;
  }
  /**
  * `.method` can get the method name of the request.
  *
  * @see {@link https://hono.dev/docs/api/request#method}
  *
  * @example
  * ```ts
  * app.get('/about/me', (c) => {
  *   const method = c.req.method // `GET`
  * })
  * ```
  */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
  * `.matchedRoutes` can return a matched route in the handler
  *
  * @deprecated
  *
  * Use matchedRoutes helper defined in "hono/route" instead.
  *
  * @see {@link https://hono.dev/docs/api/request#matchedroutes}
  *
  * @example
  * ```ts
  * app.use('*', async function logger(c, next) {
  *   await next()
  *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
  *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
  *     console.log(
  *       method,
  *       ' ',
  *       path,
  *       ' '.repeat(Math.max(10 - path.length, 0)),
  *       name,
  *       i === c.req.routeIndex ? '<- respond from here' : ''
  *     )
  *   })
  * })
  * ```
  */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
  * `.routePath` can retrieve the path registered within the handler
  *
  * @deprecated
  *
  * Use routePath helper defined in "hono/route" instead.
  *
  * @see {@link https://hono.dev/docs/api/request#routepath}
  *
  * @example
  * ```ts
  * app.get('/posts/:id', (c) => {
  *   return c.json({ path: c.req.routePath })
  * })
  * ```
  */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = /* @__PURE__ */ __name((value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
}, "raw");
var resolveCallback = /* @__PURE__ */ __name(async (str2, phase, preserveCallbacks, context, buffer) => {
  if (typeof str2 === "object" && !(str2 instanceof String)) {
    if (!(str2 instanceof Promise)) str2 = str2.toString();
    if (str2 instanceof Promise) str2 = await str2;
  }
  const callbacks = str2.callbacks;
  if (!callbacks?.length) return Promise.resolve(str2);
  if (buffer) buffer[0] += str2;
  else buffer = [str2];
  const resStr = Promise.all(callbacks.map((c) => c({
    phase,
    buffer,
    context
  }))).then((res) => Promise.all(res.filter(Boolean).map((str3) => resolveCallback(str3, phase, false, context, buffer))).then(() => buffer[0]));
  if (preserveCallbacks) return raw(await resStr, callbacks);
  else return resStr;
}, "resolveCallback");

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = /* @__PURE__ */ __name((contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
}, "setDefaultContentType");
var createResponseInstance = /* @__PURE__ */ __name((body, init) => new Response(body, init), "createResponseInstance");
var Context = class {
  static {
    __name(this, "Context");
  }
  #rawRequest;
  #req;
  /**
  * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
  *
  * @see {@link https://hono.dev/docs/api/context#env}
  *
  * @example
  * ```ts
  * // Environment object for Cloudflare Workers
  * app.get('*', async c => {
  *   const counter = c.env.COUNTER
  * })
  * ```
  */
  env = {};
  #var;
  finalized = false;
  /**
  * `.error` can get the error object from the middleware if the Handler throws an error.
  *
  * @see {@link https://hono.dev/docs/api/context#error}
  *
  * @example
  * ```ts
  * app.use('*', async (c, next) => {
  *   await next()
  *   if (c.error) {
  *     // do something...
  *   }
  * })
  * ```
  */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
  * Creates an instance of the Context class.
  *
  * @param req - The Request object.
  * @param options - Optional configuration options for the context.
  */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
  * `.req` is the instance of {@link HonoRequest}.
  */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#event}
  * The FetchEvent associated with the current request.
  *
  * @throws Will throw an error if the context does not have a FetchEvent.
  */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) return this.#executionCtx;
    else throw Error("This context has no FetchEvent");
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#executionctx}
  * The ExecutionContext associated with the current request.
  *
  * @throws Will throw an error if the context does not have an ExecutionContext.
  */
  get executionCtx() {
    if (this.#executionCtx) return this.#executionCtx;
    else throw Error("This context has no ExecutionContext");
  }
  /**
  * @see {@link https://hono.dev/docs/api/context#res}
  * The Response object for the current request.
  */
  get res() {
    return this.#res ||= createResponseInstance(null, { headers: this.#preparedHeaders ??= new Headers() });
  }
  /**
  * Sets the Response object for the current request.
  *
  * @param _res - The Response object to set.
  */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") continue;
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) _res.headers.append("set-cookie", cookie);
        } else _res.headers.set(k, v);
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
  * `.render()` can create a response within a layout.
  *
  * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
  *
  * @example
  * ```ts
  * app.get('/', (c) => {
  *   return c.render('Hello!')
  * })
  * ```
  */
  render = /* @__PURE__ */ __name((...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  }, "render");
  /**
  * Sets the layout for the response.
  *
  * @param layout - The layout to set.
  * @returns The layout function.
  */
  setLayout = /* @__PURE__ */ __name((layout) => this.#layout = layout, "setLayout");
  /**
  * Gets the current layout for the response.
  *
  * @returns The current layout function.
  */
  getLayout = /* @__PURE__ */ __name(() => this.#layout, "getLayout");
  /**
  * `.setRenderer()` can set the layout in the custom middleware.
  *
  * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
  *
  * @example
  * ```tsx
  * app.use('*', async (c, next) => {
  *   c.setRenderer((content) => {
  *     return c.html(
  *       <html>
  *         <body>
  *           <p>{content}</p>
  *         </body>
  *       </html>
  *     )
  *   })
  *   await next()
  * })
  * ```
  */
  setRenderer = /* @__PURE__ */ __name((renderer) => {
    this.#renderer = renderer;
  }, "setRenderer");
  /**
  * `.header()` can set headers.
  *
  * @see {@link https://hono.dev/docs/api/context#header}
  *
  * @example
  * ```ts
  * app.get('/welcome', (c) => {
  *   // Set headers
  *   c.header('X-Message', 'Hello!')
  *   c.header('Content-Type', 'text/plain')
  *
  *   // Append multiple headers using the append option (e.g. Vary)
  *   c.header('Vary', 'Accept-Encoding', { append: true })
  *   c.header('Vary', 'User-Agent', { append: true })
  *
  *   return c.body('Thank you for coming')
  * })
  * ```
  */
  header = /* @__PURE__ */ __name((name, value, options) => {
    if (this.finalized && !this.#res.bodyUsed) this.#res = createResponseInstance(this.#res.body, this.#res);
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) headers.delete(name);
    else if (options?.append) headers.append(name, value);
    else headers.set(name, value);
  }, "header");
  status = /* @__PURE__ */ __name((status) => {
    this.#status = status;
  }, "status");
  /**
  * `.set()` can set the value specified by the key.
  *
  * @see {@link https://hono.dev/docs/api/context#set-get}
  *
  * @example
  * ```ts
  * app.use('*', async (c, next) => {
  *   c.set('message', 'Hono is hot!!')
  *   await next()
  * })
  * ```
  */
  set = /* @__PURE__ */ __name((key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  }, "set");
  /**
  * `.get()` can use the value specified by the key.
  *
  * @see {@link https://hono.dev/docs/api/context#set-get}
  *
  * @example
  * ```ts
  * app.get('/', (c) => {
  *   const message = c.get('message')
  *   return c.text(`The message is "${message}"`)
  * })
  * ```
  */
  get = /* @__PURE__ */ __name((key) => {
    return this.#var ? this.#var.get(key) : void 0;
  }, "get");
  /**
  * `.var` can access the value of a variable.
  *
  * @see {@link https://hono.dev/docs/api/context#var}
  *
  * @example
  * ```ts
  * const result = c.var.client.oneMethod()
  * ```
  */
  get var() {
    if (!this.#var) return {};
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
    if (typeof arg === "object" && arg.headers) {
      responseHeaders ??= new Headers();
      for (const [key, value] of new Headers(arg.headers)) if (key === "set-cookie") responseHeaders.append(key, value);
      else responseHeaders.set(key, value);
    }
    if (headers) {
      if (!responseHeaders) {
        let count = 0;
        for (const k in headers) if (++count > 1 || typeof headers[k] !== "string") {
          responseHeaders = new Headers();
          break;
        }
      }
      if (responseHeaders) for (const k in headers) {
        const v = headers[k];
        if (typeof v === "string") responseHeaders.set(k, v);
        else {
          responseHeaders.delete(k);
          for (const v2 of v) responseHeaders.append(k, v2);
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, {
      status,
      headers: responseHeaders ?? headers
    });
  }
  newResponse = /* @__PURE__ */ __name((...args) => this.#newResponse(...args), "newResponse");
  /**
  * `.body()` can return the HTTP response.
  * You can set headers with `.header()` and set HTTP status code with `.status`.
  * This can also be set in `.text()`, `.json()` and so on.
  *
  * @see {@link https://hono.dev/docs/api/context#body}
  *
  * @example
  * ```ts
  * app.get('/welcome', (c) => {
  *   // Set headers
  *   c.header('X-Message', 'Hello!')
  *   c.header('Content-Type', 'text/plain')
  *   // Set HTTP status code
  *   c.status(201)
  *
  *   // Return the response body
  *   return c.body('Thank you for coming')
  * })
  * ```
  */
  body = /* @__PURE__ */ __name((data, arg, headers) => this.#newResponse(data, arg, headers), "body");
  /**
  * `.text()` can render text as `Content-Type:text/plain`.
  *
  * @see {@link https://hono.dev/docs/api/context#text}
  *
  * @example
  * ```ts
  * app.get('/say', (c) => {
  *   return c.text('Hello!')
  * })
  * ```
  */
  text = /* @__PURE__ */ __name((text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
  }, "text");
  /**
  * `.json()` can render JSON as `Content-Type:application/json`.
  *
  * @see {@link https://hono.dev/docs/api/context#json}
  *
  * @example
  * ```ts
  * app.get('/api', (c) => {
  *   return c.json({ message: 'Hello!' })
  * })
  * ```
  */
  json = /* @__PURE__ */ __name((object, arg, headers) => {
    return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
  }, "json");
  html = /* @__PURE__ */ __name((html, arg, headers) => {
    const res = /* @__PURE__ */ __name((html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers)), "res");
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  }, "html");
  /**
  * `.redirect()` can Redirect, default status code is 302.
  *
  * @see {@link https://hono.dev/docs/api/context#redirect}
  *
  * @example
  * ```ts
  * app.get('/redirect', (c) => {
  *   return c.redirect('/')
  * })
  * app.get('/redirect-permanently', (c) => {
  *   return c.redirect('/', 301)
  * })
  * ```
  */
  redirect = /* @__PURE__ */ __name((location, status) => {
    const locationString = String(location);
    this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
    return this.newResponse(null, status ?? 302);
  }, "redirect");
  /**
  * `.notFound()` can return the Not Found Response.
  *
  * @see {@link https://hono.dev/docs/api/context#notfound}
  *
  * @example
  * ```ts
  * app.get('/notfound', (c) => {
  *   return c.notFound()
  * })
  * ```
  */
  notFound = /* @__PURE__ */ __name(() => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  }, "notFound");
};

// node_modules/hono/dist/compose.js
var compose = /* @__PURE__ */ __name((middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else handler = i === middleware.length && next || void 0;
      if (handler) try {
        res = await handler(context, () => dispatch(i + 1));
      } catch (err) {
        if (err instanceof Error && onError) {
          context.error = err;
          res = await onError(err, context);
          isError = true;
        } else throw err;
      }
      else if (context.finalized === false && onNotFound) res = await onNotFound(context);
      if (res && (context.finalized === false || isError)) context.res = res;
      return context;
    }
    __name(dispatch, "dispatch");
  };
}, "compose");

// node_modules/hono/dist/helper/route/index.js
var matchedRoutes = /* @__PURE__ */ __name((c) => c.req[GET_MATCH_RESULT][0].map(([[, route]]) => route), "matchedRoutes");
var routePath = /* @__PURE__ */ __name((c, index) => matchedRoutes(c).at(index ?? c.req.routeIndex)?.path ?? "", "routePath");

// node_modules/hono/dist/router.js
var METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "options",
  "patch",
  "query"
];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
  static {
    __name(this, "UnsupportedPathError");
  }
};

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/utils/mount.js
var countTrailingSlashes = /* @__PURE__ */ __name((path) => {
  let index = path.length;
  while (index > 0 && path.charCodeAt(index - 1) === 47) index--;
  return path.length - index;
}, "countTrailingSlashes");
var getPathPrefixLength = /* @__PURE__ */ __name((c, pathPrefix, routePath2) => {
  if (!/[:*]/.test(pathPrefix)) return pathPrefix.length;
  const path = c.req.path;
  const matchResult = c.req[GET_MATCH_RESULT];
  const paramNames = /* @__PURE__ */ new Set();
  let length = 0;
  for (const part of splitRoutingPath(pathPrefix)) {
    if (part[0] === ":" && part.endsWith("}?")) throw new Error(`mount(): Optional regular expression parameters are not supported in "${routePath2}".`);
    const pattern = getPattern(part);
    if (pattern && pattern !== "*") {
      const name = pattern[1];
      if (paramNames.has(name)) throw new Error(`mount(): Duplicate path parameter "${name}" in "${routePath2}".`);
      paramNames.add(name);
    }
    if (pattern && pattern !== "*" && pattern[2] !== true) {
      const value = matchResult.length === 2 ? matchResult[1][matchResult[0][c.req.routeIndex][1][pattern[1]]] : matchResult[0][c.req.routeIndex][1][pattern[1]];
      length += value.length + 1;
    } else if (pattern || part.endsWith("*")) {
      const end = path.indexOf("/", length + 1);
      length = end === -1 ? path.length : end;
    } else length += part.length + 1;
  }
  return length;
}, "getPathPrefixLength");
var createMountedRequest = /* @__PURE__ */ __name((c, pathPrefix, routePath2) => {
  if (/[^/]\*$/.test(routePath2)) throw new Error(`mount(): Wildcard must follow "/" in "${routePath2}".`);
  const prefixLength = getPathPrefixLength(c, pathPrefix, routePath2);
  const path = c.req.path.slice(prefixLength) || "/";
  if (prefixLength > c.req.path.length || path[0] !== "/" || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(path)) throw new HTTPException(400, { message: "Invalid mounted path" });
  const rawUrl = c.req.raw.url;
  if (/^[^/?#]*\/\/[^/?#\\]*[?#\\]/.test(rawUrl)) throw new HTTPException(400, { message: "Invalid mounted path" });
  const rawPathEnd = rawUrl.search(/[?#]/);
  const rawTrailingSlashes = countTrailingSlashes(rawPathEnd === -1 ? rawUrl : rawUrl.slice(0, rawPathEnd));
  if (rawTrailingSlashes > 1 && countTrailingSlashes(c.req.path) === rawTrailingSlashes - 1) throw new HTTPException(400, { message: "Invalid mounted path" });
  const url = new URL(rawUrl);
  url.pathname = path.replace(/[\\\t\n\r]/g, encodeURIComponent);
  if (path.includes("%")) {
  }
  return new Request(url, c.req.raw);
}, "createMountedRequest");

// node_modules/hono/dist/hono-base.js
var notFoundHandler = /* @__PURE__ */ __name((c) => {
  return c.text("404 Not Found", 404);
}, "notFoundHandler");
var errorHandler = /* @__PURE__ */ __name((err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
}, "errorHandler");
var Hono = class Hono2 {
  static {
    __name(this, "Hono");
  }
  get;
  post;
  put;
  delete;
  options;
  patch;
  query;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    [...METHODS, "all"].forEach((method) => {
      this[method] = (args1, ...args) => {
        const methodName = method.toUpperCase();
        if (typeof args1 === "string") this.#path = args1;
        else this.#addRoute(methodName, this.#path, args1);
        args.forEach((handler) => {
          this.#addRoute(methodName, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          const methodName = m.toUpperCase();
          for (const handler of handlers) this.#addRoute(methodName, this.#path, handler);
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") this.#path = arg1;
      else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute("ALL", this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new Hono2({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  errorHandler = errorHandler;
  /**
  * `.route()` allows grouping other Hono instance in routes.
  *
  * @see {@link https://hono.dev/docs/api/routing#grouping}
  *
  * @param {string} path - base Path
  * @param {Hono} app - other Hono instance
  * @returns {Hono} routed Hono instance
  *
  * @example
  * ```ts
  * const app = new Hono()
  * const app2 = new Hono()
  *
  * app2.get("/user", (c) => c.text("user"))
  * app.route("/api", app2) // GET /api/user
  * ```
  */
  route(path, app2) {
    const subApp = this.basePath(path);
    app2.routes.map((r) => {
      let handler;
      if (app2.errorHandler === errorHandler) handler = r.handler;
      else {
        handler = /* @__PURE__ */ __name(async (c, next) => (await compose([], app2.errorHandler)(c, () => r.handler(c, next))).res, "handler");
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
  * `.basePath()` allows base paths to be specified.
  *
  * @see {@link https://hono.dev/docs/api/routing#base-path}
  *
  * @param {string} path - base Path
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * const api = new Hono().basePath('/api')
  * ```
  */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
  * `.onError()` handles an error and returns a customized Response.
  *
  * @see {@link https://hono.dev/docs/api/hono#error-handling}
  *
  * @param {ErrorHandler} handler - request Handler for error
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * app.onError((err, c) => {
  *   console.error(`${err}`)
  *   return c.text('Custom Error Message', 500)
  * })
  * ```
  */
  onError = /* @__PURE__ */ __name((handler) => {
    this.errorHandler = handler;
    return this;
  }, "onError");
  /**
  * `.notFound()` allows you to customize a Not Found Response.
  *
  * @see {@link https://hono.dev/docs/api/hono#not-found}
  *
  * @param {NotFoundHandler} handler - request handler for not-found
  * @returns {Hono} changed Hono instance
  *
  * @example
  * ```ts
  * app.notFound((c) => {
  *   return c.text('Custom 404 Message', 404)
  * })
  * ```
  */
  notFound = /* @__PURE__ */ __name((handler) => {
    this.#notFoundHandler = handler;
    return this;
  }, "notFound");
  /**
  * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
  *
  * @deprecated Use `mount()` from `hono/mount` instead. `.mount()` will be removed in v5.
  *
  * @see {@link https://hono.dev/docs/api/hono#mount}
  *
  * @param {string} path - base Path
  * @param {Function} applicationHandler - other Request Handler
  * @param {MountOptions} [options] - options of `.mount()`
  * @returns {Hono} mounted Hono instance
  * @throws {Error} If automatic request rewriting encounters duplicate path parameter names or an optional regular expression parameter.
  * @throws {HTTPException} With status 400 if automatic request rewriting cannot safely preserve the routed path.
  *
  * @example
  * ```ts
  * import { Router as IttyRouter } from 'itty-router'
  * import { Hono } from 'hono'
  * // Create itty-router application
  * const ittyRouter = IttyRouter()
  * // GET /itty-router/hello
  * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
  *
  * const app = new Hono()
  * app.mount('/itty-router', ittyRouter.handle)
  * ```
  *
  * @example
  * ```ts
  * const app = new Hono()
  * // Send the request to another application without modification.
  * app.mount('/app', anotherApp, {
  *   replaceRequest: (req) => req,
  * })
  * ```
  */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") optionHandler = options;
      else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) replaceRequest = /* @__PURE__ */ __name((request) => request, "replaceRequest");
        else replaceRequest = options.replaceRequest;
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    const defaultReplaceRequest = /* @__PURE__ */ __name((c) => {
      const mountedRoutePath = routePath(c);
      return createMountedRequest(c, mountedRoutePath.replace(/\/?\*$/, ""), mountedRoutePath);
    }, "defaultReplaceRequest");
    const handler = /* @__PURE__ */ __name(async (c, next) => {
      const res = await applicationHandler(replaceRequest ? replaceRequest(c.req.raw) : defaultReplaceRequest(c), ...getOptions(c));
      if (res) return res;
      await next();
    }, "handler");
    this.#addRoute("ALL", mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) return this.errorHandler(err, c);
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
  * `.fetch()` will be entry point of your app.
  *
  * @see {@link https://hono.dev/docs/api/hono#fetch}
  *
  * @param {Request} request - request Object of request
  * @param {Env} env - env Object
  * @param {ExecutionContext} executionCtx - context of execution
  * @returns {Response | Promise<Response>} response of request
  *
  */
  fetch = /* @__PURE__ */ __name((request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  }, "fetch");
  /**
  * `.request()` is a useful method for testing.
  * You can pass a URL or pathname to send a GET request.
  * app will return a Response object.
  * ```ts
  * test('GET /hello is ok', async () => {
  *   const res = await app.request('/hello')
  *   expect(res.status).toBe(200)
  * })
  * ```
  * @see https://hono.dev/docs/api/hono#request
  */
  request = /* @__PURE__ */ __name((input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    input = input.toString();
    return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
  }, "request");
  /**
  * `.fire()` automatically adds a global fetch event listener.
  * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
  * @deprecated
  * Use `fire` from `hono/service-worker` instead.
  * ```ts
  * import { Hono } from 'hono'
  * import { fire } from 'hono/service-worker'
  *
  * const app = new Hono()
  * // ...
  * fire(app)
  * ```
  * @see https://hono.dev/docs/api/hono#fire
  * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
  * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
  */
  fire = /* @__PURE__ */ __name(() => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  }, "fire");
};

// node_modules/hono/dist/router/utils.js
var createNullObject = /* @__PURE__ */ __name(() => /* @__PURE__ */ Object.create(null), "createNullObject");

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = /* @__PURE__ */ __name(((method2, path2) => {
    const matcher = matchers[method2] || matchers["ALL"];
    const staticMatch = matcher[2][path2];
    if (staticMatch) return staticMatch;
    const match3 = path2.match(matcher[0]);
    if (!match3) return [[], emptyParam];
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  }), "match");
  this.match = match2;
  return match2(method, path);
}
__name(match, "match");

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = "[^]*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/[^]*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = /* @__PURE__ */ new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) return b.length === 1 ? a < b ? -1 : 1 : -1;
  if (b.length === 1) return 1;
  if (a === "[^]*" || a === "(?:|/[^]*)") return b === "[^]*" ? -1 : 1;
  else if (b === "[^]*" || b === "(?:|/[^]*)") return -1;
  if (a === "[^/]+") return 1;
  else if (b === "[^/]+") return -1;
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
__name(compareKey, "compareKey");
var Node = class Node2 {
  static {
    __name(this, "Node");
  }
  #index;
  #varIndex;
  #children = createNullObject();
  insert(tokens, index, paramMap, context, keys) {
    let node = this;
    for (let i = 0, len = tokens.length; i < len; i++) {
      const token = tokens[i];
      const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? [
        "",
        "",
        ONLY_WILDCARD_REG_EXP_STR
      ] : [
        "",
        "",
        LABEL_REG_EXP_STR
      ] : null : token === "/*" ? [
        "",
        "",
        TAIL_WILDCARD_REG_EXP_STR
      ] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
      let nextNode;
      if (pattern) {
        const name = pattern[1];
        let regexpStr = pattern[2] || "[^/]+";
        if (name && pattern[2]) {
          if (new RegExp(regexpStr).test("")) throw PATH_ERROR;
          regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
          if (/\((?!\?:)/.test(regexpStr)) throw PATH_ERROR;
          if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) throw PATH_ERROR;
        }
        keys.push(regexpStr);
        nextNode = node.#children[regexpStr];
        if (!nextNode) {
          if (regexpStr !== "[^]*" && regexpStr !== "(?:|/[^]*)") {
            for (const k in node.#children) if ((regexpStr.length > 1 || k.length > 1) && k !== "[^]*" && k !== "(?:|/[^]*)") throw PATH_ERROR;
          }
          nextNode = node.#children[regexpStr] = new Node2();
        }
        if (name !== "") {
          nextNode.#varIndex ??= context.varIndex++;
          paramMap.push([name, nextNode.#varIndex]);
        }
      } else {
        keys.push(token);
        nextNode = node.#children[token];
        if (!nextNode) {
          for (const k in node.#children) if (k.length > 1 && k !== "[^]*" && k !== "(?:|/[^]*)") throw PATH_ERROR;
          nextNode = node.#children[token] = new Node2();
        }
      }
      node = nextNode;
    }
    if (node.#index !== void 0) throw PATH_ERROR;
    node.#index = index;
  }
  buildRegExpStr() {
    const strList = Object.keys(this.#children).sort(compareKey).map((k) => {
      const c = this.#children[k];
      const childStr = c.buildRegExpStr();
      return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
    }).filter(Boolean);
    if (typeof this.#index === "number" && this.#index !== -1) strList.unshift(`#${this.#index}`);
    if (strList.length === 0) return "";
    if (strList.length === 1) return strList[0];
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  static {
    __name(this, "Trie");
  }
  #context = { varIndex: 0 };
  #root = new Node();
  #index = 0;
  paths = createNullObject();
  insert(path, isStatic) {
    const keys = [];
    if (isStatic) {
      this.#root.insert(path.split(""), -1, [], this.#context, keys);
      this.paths[path] = [
        -1,
        [],
        keys
      ];
      return;
    }
    const paramAssoc = [];
    const groups = [];
    let markedPath = path;
    for (let i = 0; ; ) {
      let replaced = false;
      markedPath = markedPath.replace(/\{(?:\{[\d,]+\}|[^}])+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) break;
    }
    const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./gs) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) if (tokens[j].indexOf(mark) !== -1) {
        tokens[j] = tokens[j].replace(mark, groups[i][1]);
        break;
      }
    }
    this.#root.insert(tokens, this.#index, paramAssoc, this.#context, keys);
    this.paths[path] = [
      this.#index++,
      paramAssoc,
      keys
    ];
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") return [
      /^$/,
      [],
      []
    ];
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [
      new RegExp(`^${regexp}`),
      indexReplacementMap,
      paramReplacementMap
    ];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
function endsWithWildcard(keys) {
  const tail = keys[keys.length - 1];
  return tail === "[^]*" || tail === "(?:|/[^]*)";
}
__name(endsWithWildcard, "endsWithWildcard");
function covers(wildcard, target) {
  const last = wildcard.length - 1;
  for (let i = 0; i < last; i++) if (wildcard[i] !== target[i]) return false;
  return wildcard[last] === "[^]*" || target.length === last || target[last] === "/";
}
__name(covers, "covers");
var RegExpRouter = class {
  static {
    __name(this, "RegExpRouter");
  }
  name = "RegExpRouter";
  #handlers;
  #tries;
  constructor() {
    this.#handlers = { ["ALL"]: [] };
    this.#tries = { ["ALL"]: new Trie() };
  }
  #insertPath(method, path) {
    try {
      this.#tries[method].insert(path, !/\*|\/:/.test(path));
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
  }
  add(method, path, handler) {
    const handlers = this.#handlers;
    if (!handlers) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    const tries = this.#tries;
    if (!handlers[method]) {
      tries[method] = new Trie();
      handlers[method] = [...handlers["ALL"]];
      for (const p in tries["ALL"].paths) this.#insertPath(method, p);
    }
    if (path === "/*") path = "*";
    const methods = method === "ALL" ? Object.keys(handlers) : [method];
    const paths = checkOptionalParameter(path) || [path];
    for (const path2 of paths) for (const m of methods) {
      if (!tries[m].paths[path2]) this.#insertPath(m, path2);
      handlers[m].push([handler, path2]);
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = createNullObject();
    for (const method of Object.keys(this.#handlers)) matchers[method] = this.#buildMatcher(method);
    this.#handlers = this.#tries = void 0;
    return matchers;
  }
  #buildMatcher(method) {
    const handlers = this.#handlers[method];
    const trie = this.#tries[method];
    const staticMap = createNullObject();
    const handlerData = [];
    const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
    const own = createNullObject();
    const entries = handlers.map(([h, p], i) => {
      (own[p] ??= []).push(i);
      return [h, trie.paths[p][1].reduceRight((map, [key, varIndex]) => {
        map[key] = paramReplacementMap[varIndex];
        return map;
      }, createNullObject())];
    });
    const wildcards = Object.keys(own).filter((p) => endsWithWildcard(trie.paths[p][2]));
    for (const path in trie.paths) {
      const [index, , keys] = trie.paths[path];
      const indexes = [...own[path]];
      for (const p of wildcards) if (p !== path && covers(trie.paths[p][2], keys)) indexes.push(...own[p]);
      const data = indexes.sort((a, b) => a - b).map((i) => entries[i]);
      if (index === -1) {
        const last = Math.max(-1, ...data.flatMap(([, map]) => Object.values(map)));
        staticMap[path] = [data, last === -1 ? emptyParam : path.match(regexp).slice(0, last + 1)];
      } else handlerData[index] = data;
    }
    return [
      regexp,
      indexReplacementMap.map((i) => handlerData[i]),
      staticMap
    ];
  }
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  static {
    __name(this, "SmartRouter");
  }
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    this.#routes.push([
      method,
      path,
      handler
    ]);
  }
  match(method, path) {
    if (!this.#routes) throw new Error("Fatal error");
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) router.add(...routes[i2]);
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) continue;
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) throw new Error("Fatal error");
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) throw new Error("No active router has been determined yet.");
    return this.#routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = createNullObject();
var order = 0;
var Node3 = class Node4 {
  static {
    __name(this, "Node");
  }
  #methods = [];
  #children = createNullObject();
  #patterns = [];
  #pattern;
  #params = emptyParams;
  insert(method, path, handler) {
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = /* @__PURE__ */ new Set();
    let i = 0;
    for (const p of parts) {
      const nextP = parts[++i];
      const pattern = getPattern(p, nextP) || (nextP === void 0 && p && p.indexOf("*") === p.length - 1 ? p : null);
      const isParam = Array.isArray(pattern);
      const key = isParam ? pattern[0] : pattern || p;
      const child = curNode.#children[key] ||= new Node4();
      if (pattern && !child.#pattern) {
        child.#pattern = pattern;
        curNode.#patterns.push(child);
      }
      curNode = child;
      if (isParam) possibleKeys.add(pattern[1]);
    }
    curNode.#methods.push({ [method]: {
      handler,
      possibleKeys: [...possibleKeys],
      score: ++order
    } });
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m["ALL"];
      if (handlerSet) {
        handlerSet.params = createNullObject();
        handlerSets.push(handlerSet);
        for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
          const key = handlerSet.possibleKeys[i2];
          handlerSet.params[key] = params?.[key] && !i2 ? params[key] : nodeParams[key] ?? params?.[key];
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    let curNodes = [this];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else tempNodes.push(nextNode);
        }
        for (const child of node.#patterns) {
          const pattern = child.#pattern;
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (typeof pattern === "string") {
            if (pattern === "*" || part.startsWith(pattern.slice(0, -1))) {
              this.#pushHandlerSets(handlerSets, child, method, node.#params);
              if (pattern === "*") {
                child.#params = params;
                tempNodes.push(child);
              }
            }
            continue;
          }
          const [, name, matcher] = pattern;
          if (!part && matcher === true) continue;
          if (matcher !== true) {
            if (!partOffsets) {
              partOffsets = [];
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.slice(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              if (!Object.hasOwn(params, name)) params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (m[0].length === restPathString.length && child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, node.#params, params);
              for (const _ in child.#children) {
                child.#params = params;
                const componentCount = m[0].match(/\//g)?.length ?? 0;
                (curNodesQueue[componentCount] ||= []).push(child);
                break;
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            if (!Object.hasOwn(params, name)) params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets[1]) handlerSets.sort((a, b) => {
      return a.score - b.score;
    });
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  static {
    __name(this, "TrieRouter");
  }
  name = "TrieRouter";
  #node = new Node3();
  add(method, path, handler) {
    for (const result of checkOptionalParameter(path) || [path]) this.#node.insert(method, result, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono3 = class extends Hono {
  static {
    __name(this, "Hono");
  }
  /**
  * Creates an instance of the Hono class.
  *
  * @param options - Optional configuration options for the Hono instance.
  */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({ routers: [new RegExpRouter(), new TrieRouter()] });
  }
};

// node_modules/hono/dist/middleware/cors/index.js
var cors = /* @__PURE__ */ __name((options) => {
  const opts = {
    origin: "*",
    allowMethods: [
      "GET",
      "HEAD",
      "PUT",
      "POST",
      "DELETE",
      "PATCH",
      "QUERY"
    ],
    allowHeaders: [],
    exposeHeaders: [],
    ...options
  };
  const exposeHeadersStr = opts.exposeHeaders?.length ? opts.exposeHeaders.join(",") : void 0;
  const allowHeadersStr = opts.allowHeaders?.length ? opts.allowHeaders.join(",") : void 0;
  const findAllowOrigin = ((optsOrigin) => {
    if (typeof optsOrigin === "string") {
      if (optsOrigin === "*") return () => optsOrigin;
      else return (origin) => optsOrigin === origin ? origin : null;
    } else if (typeof optsOrigin === "function") return optsOrigin;
    else return (origin) => optsOrigin.includes(origin) ? origin : null;
  })(opts.origin);
  const findAllowMethods = ((optsAllowMethods) => {
    if (typeof optsAllowMethods === "function") return async (origin, c) => (await optsAllowMethods(origin, c)).join(",");
    else if (Array.isArray(optsAllowMethods)) {
      const methodsStr = optsAllowMethods.join(",");
      return () => methodsStr;
    } else return () => "";
  })(opts.allowMethods);
  return /* @__PURE__ */ __name(async function cors2(c, next) {
    function set(key, value) {
      c.res.headers.set(key, value);
    }
    __name(set, "set");
    const allowOrigin = await findAllowOrigin(c.req.header("origin") || "", c);
    if (allowOrigin) set("Access-Control-Allow-Origin", allowOrigin);
    if (opts.credentials) set("Access-Control-Allow-Credentials", "true");
    if (exposeHeadersStr) set("Access-Control-Expose-Headers", exposeHeadersStr);
    if (c.req.method === "OPTIONS") {
      if (opts.origin !== "*") c.res.headers.append("Vary", "Origin");
      if (opts.maxAge != null) set("Access-Control-Max-Age", opts.maxAge.toString());
      const allowMethods = await findAllowMethods(c.req.header("origin") || "", c);
      if (allowMethods) set("Access-Control-Allow-Methods", allowMethods);
      let headersStr = allowHeadersStr;
      if (!headersStr) {
        const requestHeaders = c.req.header("Access-Control-Request-Headers");
        if (requestHeaders) headersStr = requestHeaders.split(",").map((h) => h.trim()).join(",");
      }
      if (headersStr) {
        set("Access-Control-Allow-Headers", headersStr);
        c.res.headers.append("Vary", "Access-Control-Request-Headers");
      }
      c.res.headers.delete("Content-Length");
      c.res.headers.delete("Content-Type");
      return new Response(null, {
        headers: c.res.headers,
        status: 204,
        statusText: "No Content"
      });
    }
    await next();
    if (opts.origin !== "*") c.header("Vary", "Origin", { append: true });
  }, "cors");
}, "cors");

// src/lib/http.ts
var ApiError = class extends Error {
  constructor(status, message, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
  status;
  code;
  static {
    __name(this, "ApiError");
  }
};
var badRequest = /* @__PURE__ */ __name((message) => new ApiError(400, message, "bad_request"), "badRequest");
var unauthorized = /* @__PURE__ */ __name((message = "Please sign in to continue.") => new ApiError(401, message, "unauthorized"), "unauthorized");
var forbidden = /* @__PURE__ */ __name((message = "You do not have permission to do that.") => new ApiError(403, message, "forbidden"), "forbidden");
var notFound = /* @__PURE__ */ __name((message = "Not found.") => new ApiError(404, message, "not_found"), "notFound");
var conflict = /* @__PURE__ */ __name((message) => new ApiError(409, message, "conflict"), "conflict");
async function readJson(c) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("The request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("The request body must be a JSON object.");
  return body;
}
__name(readJson, "readJson");
function str(value, name, opts = {}) {
  if (value === void 0 || value === null) {
    if (opts.optional) return "";
    throw badRequest(`${name} is required.`);
  }
  if (typeof value !== "string") throw badRequest(`${name} must be text.`);
  const v = value.trim();
  if (opts.min !== void 0 && v.length < opts.min) throw badRequest(`${name} must be at least ${opts.min} characters.`);
  if (opts.max !== void 0 && v.length > opts.max) throw badRequest(`${name} must be at most ${opts.max} characters.`);
  return v;
}
__name(str, "str");
function int(value, name, opts = {}) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) throw badRequest(`${name} must be a whole number.`);
  if (opts.min !== void 0 && n < opts.min) throw badRequest(`${name} must be at least ${opts.min}.`);
  if (opts.max !== void 0 && n > opts.max) throw badRequest(`${name} must be at most ${opts.max}.`);
  return n;
}
__name(int, "int");
function oneOf(value, name, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw badRequest(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}
__name(oneOf, "oneOf");
function optionalInt(value, name, fallback, opts = {}) {
  if (value === void 0 || value === "") return fallback;
  return int(value, name, opts);
}
__name(optionalInt, "optionalInt");
var HASH_RE = /^[0-9a-f]{64}$/;
function hashParam(value, name = "hash") {
  if (typeof value !== "string" || !HASH_RE.test(value)) throw badRequest(`${name} must be a SHA-256 hex digest.`);
  return value;
}
__name(hashParam, "hashParam");
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
__name(chunk, "chunk");

// src/lib/policy.ts
var DEFAULT_POLICY = {
  sync: {
    mode: "auto",
    quietSeconds: 60,
    intervalMinutes: 30,
    tallyMode: "quiet",
    tallyQuietSeconds: 180,
    graceSeconds: 30,
    tallyProcesses: ["tally.exe", "tallyprime.exe", "tallyprimeserver.exe"]
  },
  full: { schedule: "daily", time: "20:00", everyHours: 12, weekday: 5, level: "maximum", keep: 14 },
  retention: { versionDays: 30 },
  tally: { snapshots: true, port: 9e3, everyMinutes: 60 },
  exclude: ["*.tmp", "~$*", "Thumbs.db", "desktop.ini", ".DS_Store"]
};
var clampInt = /* @__PURE__ */ __name((v, min, max, fallback) => {
  const n = typeof v === "number" ? Math.round(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}, "clampInt");
var pick = /* @__PURE__ */ __name((v, allowed, fallback) => typeof v === "string" && allowed.includes(v) ? v : fallback, "pick");
var cleanList = /* @__PURE__ */ __name((v, fallback, max = 40) => Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string").map((x) => x.trim()).filter((x) => x && x.length <= 120))].slice(0, max) : fallback, "cleanList");
function sanitizePolicy(input) {
  const src = input && typeof input === "object" ? input : {};
  const s = src.sync ?? {};
  const f = src.full ?? {};
  const r = src.retention ?? {};
  const t = src.tally ?? {};
  const d = DEFAULT_POLICY;
  const time = typeof f.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(f.time) ? f.time : d.full.time;
  return {
    sync: {
      mode: pick(s.mode, ["auto", "interval", "manual"], d.sync.mode),
      quietSeconds: clampInt(s.quietSeconds, 10, 3600, d.sync.quietSeconds),
      intervalMinutes: clampInt(s.intervalMinutes, 5, 1440, d.sync.intervalMinutes),
      // Older settings had a waitForTally switch; the quiet mode replaces it as the safe default.
      tallyMode: pick(s.tallyMode, ["quiet", "close"], d.sync.tallyMode),
      tallyQuietSeconds: clampInt(s.tallyQuietSeconds, 30, 3600, d.sync.tallyQuietSeconds),
      graceSeconds: clampInt(s.graceSeconds, 0, 600, d.sync.graceSeconds),
      tallyProcesses: [...new Set(cleanList(s.tallyProcesses, d.sync.tallyProcesses, 12).map((p) => p.toLowerCase()))]
    },
    full: {
      schedule: pick(f.schedule, ["daily", "hours", "weekly", "off"], d.full.schedule),
      time,
      everyHours: clampInt(f.everyHours, 1, 168, d.full.everyHours),
      weekday: clampInt(f.weekday, 0, 6, d.full.weekday),
      level: pick(f.level, ["balanced", "high", "maximum"], d.full.level),
      keep: clampInt(f.keep, 1, 365, d.full.keep)
    },
    retention: { versionDays: clampInt(r.versionDays, 0, 3650, d.retention.versionDays) },
    tally: {
      snapshots: typeof t.snapshots === "boolean" ? t.snapshots : d.tally.snapshots,
      port: clampInt(t.port, 1, 65535, d.tally.port),
      everyMinutes: clampInt(t.everyMinutes, 15, 1440, d.tally.everyMinutes)
    },
    exclude: cleanList(src.exclude, d.exclude, 60)
  };
}
__name(sanitizePolicy, "sanitizePolicy");
async function loadPolicy(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'policy'").first();
  if (!row) return DEFAULT_POLICY;
  try {
    return sanitizePolicy(JSON.parse(row.value));
  } catch {
    return DEFAULT_POLICY;
  }
}
__name(loadPolicy, "loadPolicy");
async function savePolicy(db, policy) {
  await db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(JSON.stringify(policy), Date.now()).run();
}
__name(savePolicy, "savePolicy");

// src/lib/crypto.ts
var ITERATIONS = 1e5;
var encoder = new TextEncoder();
function toB64Url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(toB64Url, "toB64Url");
function fromB64Url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const raw2 = atob(b64);
  const out = new Uint8Array(raw2.length);
  for (let i = 0; i < raw2.length; i++) out[i] = raw2.charCodeAt(i);
  return out;
}
__name(fromB64Url, "fromB64Url");
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
function constantTimeEqualText(a, b) {
  return constantTimeEqual(encoder.encode(a), encoder.encode(b));
}
__name(constantTimeEqualText, "constantTimeEqualText");
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}
__name(pbkdf2, "pbkdf2");
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${toB64Url(salt)}$${toB64Url(hash)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS) return false;
  const expected = fromB64Url(parts[3]);
  const actual = await pbkdf2(password, fromB64Url(parts[2]), iterations);
  return constantTimeEqual(actual, expected);
}
__name(verifyPassword, "verifyPassword");
async function dummyVerify(password) {
  await pbkdf2(password, new Uint8Array(16), ITERATIONS);
}
__name(dummyVerify, "dummyVerify");
function randomToken(bytes = 32) {
  return toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
__name(randomToken, "randomToken");
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");

// src/lib/auth.ts
var SLIDE_AFTER_MS = 10 * 60 * 1e3;
function sessionDays(env) {
  const n = Number(env.SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
__name(sessionDays, "sessionDays");
async function loadUserPaths(db, userId) {
  const { results } = await db.prepare("SELECT path FROM user_paths WHERE user_id = ? ORDER BY path").bind(userId).all();
  return results.map((r) => r.path);
}
__name(loadUserPaths, "loadUserPaths");
async function toAuthUser(db, row) {
  const needsPaths = row.scope_mode === "include" || row.scope_mode === "exclude";
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    access: row.role === "superadmin" ? "write" : row.access,
    scopeMode: row.role === "superadmin" ? "all" : row.scope_mode,
    paths: needsPaths && row.role !== "superadmin" ? await loadUserPaths(db, row.id) : []
  };
}
__name(toAuthUser, "toAuthUser");
async function createSession(env, userId, device) {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + sessionDays(env) * 864e5;
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(await sha256Hex(token), userId, device, now, now, expiresAt).run();
  return { token, expiresAt };
}
__name(createSession, "createSession");
function deviceName(c) {
  const d = c.req.header("x-device");
  return d ? d.slice(0, 120) : null;
}
__name(deviceName, "deviceName");
var requireAuth = /* @__PURE__ */ __name(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const match2 = /^Bearer\s+([A-Za-z0-9_-]{20,})$/i.exec(header);
  if (!match2) throw unauthorized();
  const tokenHash = await sha256Hex(match2[1]);
  const row = await c.env.DB.prepare(
    `SELECT u.*, s.expires_at AS s_expires, s.last_seen_at AS s_seen
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(tokenHash).first();
  const now = Date.now();
  if (!row || row.s_expires < now) throw unauthorized("Your session has ended. Please sign in again.");
  if (row.disabled) throw unauthorized("Your access has been revoked. Contact your administrator.");
  if (now - row.s_seen > SLIDE_AFTER_MS) {
    const expires = now + sessionDays(c.env) * 864e5;
    c.executionCtx.waitUntil(
      c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").bind(now, expires, tokenHash).run()
    );
  }
  c.set("user", await toAuthUser(c.env.DB, row));
  c.set("tokenHash", tokenHash);
  await next();
}, "requireAuth");
var requireAdmin = /* @__PURE__ */ __name(async (c, next) => {
  if (c.get("user").role !== "superadmin") throw forbidden("Only the administrator can do that.");
  await next();
}, "requireAdmin");
var requireWrite = /* @__PURE__ */ __name(async (c, next) => {
  const u = c.get("user");
  if (u.role !== "superadmin" && u.access !== "write") throw forbidden("Your account has read-only access.");
  await next();
}, "requireWrite");
async function audit(env, user, action, detail) {
  await env.DB.prepare("INSERT INTO audit_log (at, user_id, username, action, detail) VALUES (?, ?, ?, ?, ?)").bind(Date.now(), user?.id ?? null, user?.username ?? null, action, detail === void 0 ? null : JSON.stringify(detail)).run();
}
__name(audit, "audit");

// src/lib/paths.ts
function normalizeRelPath(input, what = "Path") {
  if (typeof input !== "string") throw badRequest(`${what} must be text.`);
  const p = input.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!p) throw badRequest(`${what} cannot be empty.`);
  if (p.length > 1024) throw badRequest(`${what} is too long.`);
  if (/[\u0000-\u001f]/.test(p)) throw badRequest(`${what} contains invalid characters.`);
  if (/^[a-zA-Z]:/.test(p)) throw badRequest(`${what} must be relative to the backup folder.`);
  for (const seg of p.split("/")) {
    if (seg === "." || seg === "..") throw badRequest(`${what} cannot contain "." or ".." segments.`);
  }
  return p;
}
__name(normalizeRelPath, "normalizeRelPath");
function isUnder(path, folder) {
  const a = path.toLowerCase();
  const b = folder.toLowerCase();
  return a === b || a.startsWith(b + "/");
}
__name(isUnder, "isUnder");
function compactFolders(paths) {
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const out = [];
  for (const p of unique) if (!out.some((o) => isUnder(p, o))) out.push(p);
  return out.sort((a, b) => a.localeCompare(b));
}
__name(compactFolders, "compactFolders");
function scopeAllows(mode, folders, path) {
  switch (mode) {
    case "all":
      return true;
    case "none":
      return false;
    case "include":
      return folders.some((f) => isUnder(path, f));
    case "exclude":
      return !folders.some((f) => isUnder(path, f));
  }
}
__name(scopeAllows, "scopeAllows");
function canRead(user, path) {
  if (user.role === "superadmin") return true;
  return scopeAllows(user.scopeMode, user.paths, path);
}
__name(canRead, "canRead");
function canWrite(user, path) {
  if (user.role === "superadmin") return true;
  return user.access === "write" && scopeAllows(user.scopeMode, user.paths, path);
}
__name(canWrite, "canWrite");
function filterReadable(user, rows) {
  if (user.role === "superadmin" || user.scopeMode === "all") return rows;
  if (user.scopeMode === "none") return [];
  return rows.filter((r) => canRead(user, r.path));
}
__name(filterReadable, "filterReadable");

// src/routes/files.ts
var blobKey = /* @__PURE__ */ __name((hash) => `blobs/${hash.slice(0, 2)}/${hash}`, "blobKey");
var FULL_KEY_RE = /^full\/(\d+)\.tar\.zst$/;
var BLOB_KEY_RE = /^blobs\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
var MAX_CHANGES_PER_CALL = 200;
async function existingBlobs(db, hashes) {
  const found = /* @__PURE__ */ new Set();
  for (const part of chunk([...new Set(hashes)], 90)) {
    const { results } = await db.prepare(`SELECT hash FROM blobs WHERE hash IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    for (const r of results) found.add(r.hash);
  }
  return found;
}
__name(existingBlobs, "existingBlobs");
async function authorizeUploadKey(c, key) {
  if (typeof key !== "string") throw badRequest("Upload key is required.");
  const user = c.get("user");
  const blob = BLOB_KEY_RE.exec(key);
  if (blob) {
    if (blob[1] !== blob[2].slice(0, 2)) throw badRequest("Invalid upload key.");
    if (user.role !== "superadmin" && user.access !== "write") throw forbidden("Your account has read-only access.");
    return { kind: "blob", key, hash: blob[2] };
  }
  const full = FULL_KEY_RE.exec(key);
  if (full) {
    if (user.role !== "superadmin") throw forbidden("Only the administrator can upload complete backups.");
    const row = await c.env.DB.prepare("SELECT status FROM full_backups WHERE id = ?").bind(Number(full[1])).first();
    if (!row) throw notFound("That backup no longer exists.");
    if (row.status !== "uploading") throw conflict("That backup is already finished.");
    return { kind: "full", key, id: Number(full[1]) };
  }
  throw badRequest("Invalid upload key.");
}
__name(authorizeUploadKey, "authorizeUploadKey");
async function recordBlob(db, hash, size, storedSize) {
  await db.prepare("INSERT INTO blobs (hash, size, stored_size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING").bind(hash, size, storedSize, Date.now()).run();
}
__name(recordBlob, "recordBlob");
function registerFiles(app2) {
  app2.get("/api/folders", requireAuth, async (c) => {
    const { results } = await c.env.DB.prepare("SELECT path, size FROM files WHERE deleted = 0").all();
    const rows = filterReadable(c.get("user"), results);
    const folders = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const segs = r.path.split("/");
      for (let i = 1; i < segs.length; i++) {
        const f = segs.slice(0, i).join("/");
        const agg = folders.get(f) ?? { files: 0, bytes: 0 };
        agg.files += 1;
        agg.bytes += r.size;
        folders.set(f, agg);
      }
    }
    return c.json({
      totalFiles: rows.length,
      totalBytes: rows.reduce((s, r) => s + r.size, 0),
      folders: [...folders.entries()].map(([path, a]) => ({ path, ...a })).sort((a, b) => a.path.localeCompare(b.path))
    });
  });
  app2.get("/api/snapshot", requireAuth, async (c) => {
    const at = optionalInt(c.req.query("at"), "at", Date.now(), { min: 0 });
    const { results } = await c.env.DB.prepare(
      `SELECT v.path, v.hash, v.size, v.mtime, v.id AS version_id, v.created_at
         FROM versions v
         JOIN (SELECT MAX(id) AS id FROM versions WHERE created_at <= ? GROUP BY path) last ON last.id = v.id
        WHERE v.op != 'delete'
        ORDER BY v.path`
    ).bind(at).all();
    const files = filterReadable(c.get("user"), results).map((r) => ({
      path: r.path,
      hash: r.hash,
      size: r.size,
      mtime: r.mtime,
      versionId: r.version_id,
      changedAt: r.created_at
    }));
    return c.json({ at, files });
  });
  app2.get("/api/timeline", requireAuth, async (c) => {
    const now = Date.now();
    const to = optionalInt(c.req.query("to"), "to", now, { min: 0 });
    const from = optionalInt(c.req.query("from"), "from", to - 7 * 864e5, { min: 0 });
    if (from > to) throw badRequest('"from" must be before "to".');
    const limit = optionalInt(c.req.query("limit"), "limit", 2e4, { min: 1, max: 5e4 });
    const [events, bounds] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT id, path, op, hash, size, mtime, created_at, batch_id
           FROM versions WHERE created_at > ? AND created_at <= ? ORDER BY id DESC LIMIT ?`
      ).bind(from, to, limit),
      c.env.DB.prepare("SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest FROM versions")
    ]);
    const rows = filterReadable(c.get("user"), events.results);
    const b = bounds.results[0] ?? {};
    return c.json({ from, to, earliest: b.earliest, latest: b.latest, truncated: events.results.length >= limit, events: rows });
  });
  app2.get("/api/versions", requireAuth, async (c) => {
    const path = normalizeRelPath(c.req.query("path"));
    if (!canRead(c.get("user"), path)) throw forbidden("You do not have access to that file.");
    const { results } = await c.env.DB.prepare(
      "SELECT id, op, hash, size, mtime, created_at, batch_id FROM versions WHERE path = ? ORDER BY id DESC LIMIT 500"
    ).bind(path).all();
    return c.json({ path, versions: results });
  });
  app2.post("/api/blobs/missing", requireAuth, requireWrite, async (c) => {
    const body = await readJson(c);
    if (!Array.isArray(body.hashes) || body.hashes.length > 1e3) throw badRequest("Send between 0 and 1000 hashes.");
    const hashes = body.hashes.map((h) => hashParam(h));
    const found = await existingBlobs(c.env.DB, hashes);
    return c.json({ missing: [...new Set(hashes)].filter((h) => !found.has(h)) });
  });
  app2.put("/api/blobs/:hash", requireAuth, requireWrite, async (c) => {
    const hash = hashParam(c.req.param("hash"));
    const size = int(c.req.header("x-raw-size"), "X-Raw-Size header", { min: 0 });
    const length = int(c.req.header("content-length"), "Content-Length header", { min: 1 });
    if (!c.req.raw.body) throw badRequest("Upload body is empty.");
    await c.env.BUCKET.put(blobKey(hash), c.req.raw.body, {
      httpMetadata: { contentType: "application/zstd" },
      customMetadata: { rawSize: String(size) }
    });
    await recordBlob(c.env.DB, hash, size, length);
    return c.json({ ok: true, hash });
  });
  app2.get("/api/blobs/:hash", requireAuth, async (c) => {
    const hash = hashParam(c.req.param("hash"));
    const user = c.get("user");
    if (user.role !== "superadmin") {
      const { results } = await c.env.DB.prepare("SELECT DISTINCT path FROM versions WHERE hash = ? LIMIT 200").bind(hash).all();
      if (!results.some((r) => canRead(user, r.path))) throw forbidden("You do not have access to that file.");
    }
    const obj = await c.env.BUCKET.get(blobKey(hash));
    if (!obj) throw notFound("That file data is missing from storage.");
    return new Response(obj.body, {
      headers: {
        "content-type": "application/zstd",
        "content-length": String(obj.size),
        "x-raw-size": obj.customMetadata?.rawSize ?? "",
        "cache-control": "private, max-age=31536000, immutable"
      }
    });
  });
  app2.post("/api/uploads", requireAuth, async (c) => {
    const body = await readJson(c);
    const target = await authorizeUploadKey(c, body.key);
    const upload = await c.env.BUCKET.createMultipartUpload(target.key, {
      httpMetadata: { contentType: "application/zstd" },
      customMetadata: target.kind === "blob" ? { rawSize: String(int(body.size, "size", { min: 0 })) } : {}
    });
    return c.json({ key: upload.key, uploadId: upload.uploadId });
  });
  app2.put("/api/uploads/:uploadId/parts/:part", requireAuth, async (c) => {
    const target = await authorizeUploadKey(c, c.req.query("key"));
    const part = int(c.req.param("part"), "Part number", { min: 1, max: 1e4 });
    if (!c.req.raw.body) throw badRequest("Upload body is empty.");
    const upload = c.env.BUCKET.resumeMultipartUpload(target.key, c.req.param("uploadId"));
    try {
      const uploaded = await upload.uploadPart(part, c.req.raw.body);
      return c.json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
    } catch (err) {
      throw new ApiError(400, `Upload part failed: ${err.message}`, "upload_failed");
    }
  });
  app2.post("/api/uploads/:uploadId/complete", requireAuth, async (c) => {
    const body = await readJson(c);
    const target = await authorizeUploadKey(c, body.key);
    if (!Array.isArray(body.parts) || body.parts.length === 0) throw badRequest("Parts are required.");
    const parts = body.parts.map((p) => ({ partNumber: int(p?.partNumber, "partNumber", { min: 1 }), etag: String(p?.etag ?? "") }));
    const upload = c.env.BUCKET.resumeMultipartUpload(target.key, c.req.param("uploadId"));
    let obj;
    try {
      obj = await upload.complete(parts);
    } catch (err) {
      throw new ApiError(400, `Could not finish the upload: ${err.message}`, "upload_failed");
    }
    if (target.kind === "blob") await recordBlob(c.env.DB, target.hash, int(body.size, "size", { min: 0 }), obj.size);
    return c.json({ ok: true, size: obj.size });
  });
  app2.delete("/api/uploads/:uploadId", requireAuth, async (c) => {
    const target = await authorizeUploadKey(c, c.req.query("key"));
    try {
      await c.env.BUCKET.resumeMultipartUpload(target.key, c.req.param("uploadId")).abort();
    } catch {
    }
    return c.json({ ok: true });
  });
  app2.post("/api/batches", requireAuth, requireWrite, async (c) => {
    const body = await readJson(c).catch(() => ({}));
    const device = typeof body.device === "string" ? body.device.slice(0, 120) : c.req.header("x-device")?.slice(0, 120) ?? null;
    const res = await c.env.DB.prepare("INSERT INTO batches (user_id, device, started_at, status) VALUES (?, ?, ?, 'running')").bind(c.get("user").id, device, Date.now()).run();
    return c.json({ id: Number(res.meta.last_row_id) });
  });
  app2.post("/api/batches/:id/changes", requireAuth, requireWrite, async (c) => {
    const user = c.get("user");
    const id = int(c.req.param("id"), "Batch id", { min: 1 });
    const batch = await c.env.DB.prepare("SELECT user_id, status FROM batches WHERE id = ?").bind(id).first();
    if (!batch) throw notFound("That sync run no longer exists.");
    if (batch.user_id !== user.id && user.role !== "superadmin") throw forbidden();
    if (batch.status !== "running") throw conflict("That sync run has already finished.");
    const body = await readJson(c);
    if (!Array.isArray(body.changes) || body.changes.length === 0 || body.changes.length > MAX_CHANGES_PER_CALL) {
      throw badRequest(`Send between 1 and ${MAX_CHANGES_PER_CALL} changes per request.`);
    }
    const byPath = /* @__PURE__ */ new Map();
    for (const raw2 of body.changes) {
      const path = normalizeRelPath(raw2?.path);
      if (!canWrite(user, path)) throw forbidden(`You cannot back up "${path}".`);
      const op = raw2?.op === "delete" ? "delete" : raw2?.op === "upsert" ? "upsert" : null;
      if (!op) throw badRequest('Each change needs op "upsert" or "delete".');
      byPath.set(path, {
        path,
        op,
        hash: op === "upsert" ? hashParam(raw2.hash) : null,
        size: op === "upsert" ? int(raw2.size, "size", { min: 0 }) : 0,
        mtime: int(raw2.mtime ?? 0, "mtime", { min: 0 })
      });
    }
    const changes = [...byPath.values()];
    const needed = changes.filter((ch) => ch.hash).map((ch) => ch.hash);
    const present = await existingBlobs(c.env.DB, needed);
    const absent = needed.filter((h) => !present.has(h));
    if (absent.length) throw new ApiError(409, `File data for ${absent.length} file(s) has not been uploaded yet.`, "missing_blobs");
    const current = /* @__PURE__ */ new Map();
    for (const part of chunk(changes.map((ch) => ch.path), 90)) {
      const { results } = await c.env.DB.prepare(`SELECT path, hash, deleted FROM files WHERE path IN (${part.map(() => "?").join(",")})`).bind(...part).all();
      for (const r of results) current.set(r.path, r);
    }
    const db = c.env.DB;
    const now = Date.now();
    const stmts = [];
    const counts = { add: 0, modify: 0, delete: 0, skipped: 0 };
    for (const ch of changes) {
      const cur = current.get(ch.path);
      const live = cur && !cur.deleted;
      let op;
      if (ch.op === "delete") {
        if (!live) {
          counts.skipped++;
          continue;
        }
        op = "delete";
      } else if (live && cur.hash === ch.hash) {
        stmts.push(db.prepare("UPDATE files SET mtime = ? WHERE path = ?").bind(ch.mtime, ch.path));
        counts.skipped++;
        continue;
      } else {
        op = live ? "modify" : "add";
      }
      counts[op]++;
      stmts.push(
        db.prepare("INSERT INTO versions (path, op, hash, size, mtime, created_at, batch_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(ch.path, op, ch.hash, ch.size, ch.mtime, now, id, user.id),
        db.prepare(
          `INSERT INTO files (path, hash, size, mtime, deleted, version_id, updated_at)
             VALUES (?, ?, ?, ?, ?, (SELECT MAX(id) FROM versions WHERE path = ?), ?)
             ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mtime = excluded.mtime,
               deleted = excluded.deleted, version_id = excluded.version_id, updated_at = excluded.updated_at`
        ).bind(ch.path, ch.hash, ch.size, ch.mtime, op === "delete" ? 1 : 0, ch.path, now)
      );
    }
    stmts.push(
      db.prepare("UPDATE batches SET added = added + ?, modified = modified + ?, deleted = deleted + ? WHERE id = ?").bind(counts.add, counts.modify, counts.delete, id)
    );
    await db.batch(stmts);
    return c.json({ recorded: counts.add + counts.modify + counts.delete, ...counts });
  });
  app2.post("/api/batches/:id/finish", requireAuth, requireWrite, async (c) => {
    const user = c.get("user");
    const id = int(c.req.param("id"), "Batch id", { min: 1 });
    const body = await readJson(c);
    const batch = await c.env.DB.prepare("SELECT * FROM batches WHERE id = ?").bind(id).first();
    if (!batch) throw notFound("That sync run no longer exists.");
    if (batch.user_id !== user.id && user.role !== "superadmin") throw forbidden();
    const status = body.status === "failed" ? "failed" : "done";
    const message = typeof body.message === "string" ? body.message.slice(0, 500) : null;
    const bytes = typeof body.bytesUploaded === "number" && body.bytesUploaded >= 0 ? Math.round(body.bytesUploaded) : 0;
    if (status === "done" && batch.added + batch.modified + batch.deleted === 0) {
      await c.env.DB.prepare("DELETE FROM batches WHERE id = ?").bind(id).run();
      return c.json({ ok: true, empty: true });
    }
    await c.env.DB.prepare("UPDATE batches SET status = ?, message = ?, bytes_uploaded = ?, finished_at = ? WHERE id = ?").bind(status, message, bytes, Date.now(), id).run();
    return c.json({ ok: true });
  });
  app2.get("/api/batches", requireAuth, async (c) => {
    const before = optionalInt(c.req.query("before"), "before", Number.MAX_SAFE_INTEGER, { min: 1 });
    const limit = optionalInt(c.req.query("limit"), "limit", 50, { min: 1, max: 200 });
    const { results } = await c.env.DB.prepare(
      `SELECT b.id, b.device, b.started_at, b.finished_at, b.status, b.added, b.modified, b.deleted, b.bytes_uploaded, b.message,
              u.username, u.display_name
         FROM batches b LEFT JOIN users u ON u.id = b.user_id
        WHERE b.id < ? ORDER BY b.id DESC LIMIT ?`
    ).bind(before, limit).all();
    return c.json({ batches: results });
  });
  app2.get("/api/batches/:id/changes", requireAuth, async (c) => {
    const id = int(c.req.param("id"), "Batch id", { min: 1 });
    const { results } = await c.env.DB.prepare(
      "SELECT id, path, op, hash, size, mtime, created_at FROM versions WHERE batch_id = ? ORDER BY path LIMIT 5000"
    ).bind(id).all();
    return c.json({ changes: filterReadable(c.get("user"), results) });
  });
}
__name(registerFiles, "registerFiles");

// src/routes/tally.ts
var tallyKey = /* @__PURE__ */ __name((hash) => `tally/${hash}.json.gz`, "tallyKey");
var MAX_SNAPSHOT_BYTES = 60 * 1024 * 1024;
function mayRead(user, folder) {
  return user.role === "superadmin" || folder !== null && canRead(user, folder);
}
__name(mayRead, "mayRead");
var view = /* @__PURE__ */ __name((r) => ({
  id: r.id,
  companyKey: r.company_key,
  companyName: r.company_name,
  folder: r.folder,
  capturedAt: r.captured_at,
  hash: r.hash,
  rawSize: r.raw_size,
  storedSize: r.stored_size,
  ledgers: r.ledgers,
  vouchers: r.vouchers,
  lastVoucher: r.last_voucher,
  device: r.device
}), "view");
function registerTally(app2) {
  app2.put("/api/tally/data/:hash", requireAuth, requireWrite, async (c) => {
    const hash = hashParam(c.req.param("hash"));
    const length = int(c.req.header("content-length"), "Content-Length header", { min: 1, max: MAX_SNAPSHOT_BYTES });
    const raw2 = int(c.req.header("x-raw-size"), "X-Raw-Size header", { min: 1 });
    if (!c.req.raw.body) throw badRequest("Upload body is empty.");
    const key = tallyKey(hash);
    if (await c.env.BUCKET.head(key)) {
      await c.req.raw.body.cancel();
      return c.json({ ok: true, stored: false });
    }
    await c.env.BUCKET.put(key, c.req.raw.body, {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
      customMetadata: { rawSize: String(raw2), storedSize: String(length) }
    });
    return c.json({ ok: true, stored: true });
  });
  app2.post("/api/tally/snapshots", requireAuth, requireWrite, async (c) => {
    const user = c.get("user");
    const b = await readJson(c);
    const hash = hashParam(b.hash);
    const companyName = str(b.companyName, "Company name", { min: 1, max: 200 });
    const companyKey = str(b.companyKey, "Company key", { min: 1, max: 200 });
    const folder = b.folder === null || b.folder === void 0 || b.folder === "" ? null : normalizeRelPath(b.folder, "Company folder");
    if (folder ? !canWrite(user, folder) : user.role !== "superadmin") throw forbidden("You cannot back up that company folder.");
    const head = await c.env.BUCKET.head(tallyKey(hash));
    if (!head) throw badRequest("Upload the snapshot data first.");
    const capturedAt = int(b.capturedAt, "Captured at", { min: 0 });
    const lastVoucher = typeof b.lastVoucher === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.lastVoucher) ? b.lastVoucher : null;
    const res = await c.env.DB.prepare(
      `INSERT INTO tally_snapshots (company_key, company_name, folder, captured_at, hash, raw_size, stored_size, ledgers, vouchers, last_voucher, device, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      companyKey,
      companyName,
      folder,
      Math.min(capturedAt, Date.now() + 6e4),
      hash,
      Number(head.customMetadata?.rawSize ?? 0),
      head.size,
      int(b.ledgers ?? 0, "Ledgers", { min: 0 }),
      int(b.vouchers ?? 0, "Vouchers", { min: 0 }),
      lastVoucher,
      c.req.header("x-device")?.slice(0, 80) ?? null,
      user.id
    ).run();
    return c.json({ id: Number(res.meta.last_row_id) });
  });
  app2.get("/api/tally/companies", requireAuth, async (c) => {
    const user = c.get("user");
    const { results } = await c.env.DB.prepare(
      `SELECT s.company_key, s.company_name, s.folder, s.captured_at AS latest, s.vouchers, s.ledgers, s.last_voucher,
              agg.n, agg.first
         FROM tally_snapshots s
         JOIN (SELECT company_key, COUNT(*) AS n, MIN(captured_at) AS first, MAX(id) AS last_id FROM tally_snapshots GROUP BY company_key) agg
           ON agg.last_id = s.id
        ORDER BY s.company_name COLLATE NOCASE`
    ).all();
    return c.json({
      companies: results.filter((r) => mayRead(user, r.folder)).map((r) => ({
        companyKey: r.company_key,
        companyName: r.company_name,
        folder: r.folder,
        snapshots: r.n,
        firstAt: r.first,
        latestAt: r.latest,
        ledgers: r.ledgers,
        vouchers: r.vouchers,
        lastVoucher: r.last_voucher
      }))
    });
  });
  app2.get("/api/tally/snapshots", requireAuth, async (c) => {
    const user = c.get("user");
    const company = str(c.req.query("company"), "Company", { min: 1, max: 200 });
    const limit = optionalInt(c.req.query("limit"), "limit", 500, { min: 1, max: 2e3 });
    const { results } = await c.env.DB.prepare("SELECT * FROM tally_snapshots WHERE company_key = ? ORDER BY captured_at DESC, id DESC LIMIT ?").bind(company, limit).all();
    return c.json({ snapshots: results.filter((r) => mayRead(user, r.folder)).map(view) });
  });
  app2.get("/api/tally/snapshots/:id/data", requireAuth, async (c) => {
    const user = c.get("user");
    const id = int(Number(c.req.param("id")), "Snapshot", { min: 1 });
    const row = await c.env.DB.prepare("SELECT * FROM tally_snapshots WHERE id = ?").bind(id).first();
    if (!row || !mayRead(user, row.folder)) throw notFound("That Tally snapshot does not exist.");
    const obj = await c.env.BUCKET.get(tallyKey(row.hash));
    if (!obj) throw notFound("The snapshot data is missing from storage.");
    return new Response(obj.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
        "cache-control": "private, max-age=31536000, immutable"
      },
      encodeBody: "manual"
    });
  });
}
__name(registerTally, "registerTally");

// src/maintenance.ts
var DAY = 864e5;
async function runMaintenance(env) {
  const db = env.DB;
  const now = Date.now();
  const policy = await loadPolicy(db);
  const report = { sessions: 0, versions: 0, tombstones: 0, blobs: 0, staleBatches: 0, staleFull: 0, audit: 0, tallySnapshots: 0, tallyData: 0 };
  report.sessions = (await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run()).meta.changes ?? 0;
  if (policy.retention.versionDays > 0) {
    const cutoff = now - policy.retention.versionDays * DAY;
    report.versions = (await db.prepare(
      `DELETE FROM versions WHERE created_at < ?1
               AND id NOT IN (SELECT MAX(id) FROM versions WHERE created_at < ?1 GROUP BY path)`
    ).bind(cutoff).run()).meta.changes ?? 0;
    const res = await db.batch([
      db.prepare("DELETE FROM versions WHERE path IN (SELECT path FROM files WHERE deleted = 1 AND updated_at < ?)").bind(cutoff),
      db.prepare("DELETE FROM files WHERE deleted = 1 AND updated_at < ?").bind(cutoff)
    ]);
    report.tombstones = res[1]?.meta.changes ?? 0;
  }
  for (let round = 0; round < 10; round++) {
    const { results } = await db.prepare(
      `SELECT hash FROM blobs b WHERE b.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.hash = b.hash) LIMIT 500`
    ).bind(now - DAY).all();
    if (!results.length) break;
    await env.BUCKET.delete(results.map((r) => blobKey(r.hash)));
    await db.batch(results.map((r) => db.prepare("DELETE FROM blobs WHERE hash = ?").bind(r.hash)));
    report.blobs += results.length;
  }
  report.staleBatches = (await db.prepare("UPDATE batches SET status = 'failed', message = 'Interrupted', finished_at = ? WHERE status = 'running' AND started_at < ?").bind(now, now - DAY).run()).meta.changes ?? 0;
  const { results: stale } = await db.prepare("SELECT id, r2_key FROM full_backups WHERE status = 'uploading' AND created_at < ?").bind(now - 2 * DAY).all();
  for (const row of stale) {
    await env.BUCKET.delete([row.r2_key, `full/${row.id}.manifest.json`]);
    await db.prepare("UPDATE full_backups SET status = 'failed', note = 'Interrupted', completed_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  report.staleFull = stale.length;
  await db.prepare("DELETE FROM full_backups WHERE status = 'failed' AND created_at < ?").bind(now - 7 * DAY).run();
  report.audit = (await db.prepare("DELETE FROM audit_log WHERE at < ?").bind(now - 365 * DAY).run()).meta.changes ?? 0;
  if (policy.retention.versionDays > 0) {
    report.tallySnapshots = (await db.prepare("DELETE FROM tally_snapshots WHERE captured_at < ? AND id NOT IN (SELECT MAX(id) FROM tally_snapshots GROUP BY company_key)").bind(now - policy.retention.versionDays * DAY).run()).meta.changes ?? 0;
  }
  let cursor;
  for (let round = 0; round < 10; round++) {
    const page = await env.BUCKET.list({ prefix: "tally/", cursor, limit: 500 });
    const old = page.objects.filter((o) => o.uploaded.getTime() < now - DAY);
    const hashes = old.map((o) => o.key.slice("tally/".length, -".json.gz".length));
    if (hashes.length) {
      const used = /* @__PURE__ */ new Set();
      for (const part of chunk(hashes, 90)) {
        const { results } = await db.prepare(`SELECT DISTINCT hash FROM tally_snapshots WHERE hash IN (${part.map(() => "?").join(",")})`).bind(...part).all();
        for (const r of results) used.add(r.hash);
      }
      const unused = hashes.filter((h) => !used.has(h));
      if (unused.length) await env.BUCKET.delete(unused.map(tallyKey));
      report.tallyData += unused.length;
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return report;
}
__name(runMaintenance, "runMaintenance");

// src/routes/full.ts
var fullKey = /* @__PURE__ */ __name((id) => `full/${id}.tar.zst`, "fullKey");
var manifestKey = /* @__PURE__ */ __name((id) => `full/${id}.manifest.json`, "manifestKey");
async function deleteFull(env, row) {
  await env.BUCKET.delete([row.r2_key, manifestKey(row.id)]);
  await env.DB.prepare("DELETE FROM full_backups WHERE id = ?").bind(row.id).run();
}
__name(deleteFull, "deleteFull");
async function enforceFullRetention(env, keep) {
  const { results } = await env.DB.prepare(
    "SELECT id, r2_key FROM full_backups WHERE status = 'complete' ORDER BY created_at DESC LIMIT -1 OFFSET ?"
  ).bind(keep).all();
  for (const row of results) await deleteFull(env, row);
  return results.length;
}
__name(enforceFullRetention, "enforceFullRetention");
function parseRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const offset = Number(m[1]);
  const end = m[2] ? Number(m[2]) : void 0;
  return end !== void 0 && end >= offset ? { offset, length: end - offset + 1 } : { offset };
}
__name(parseRange, "parseRange");
function registerFull(app2) {
  app2.get("/api/full-backups", requireAuth, requireAdmin, async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT f.*, u.username FROM full_backups f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.status = 'complete' OR f.created_at > ?
        ORDER BY f.created_at DESC LIMIT 500`
    ).bind(Date.now() - 7 * 864e5).all();
    return c.json({ backups: results });
  });
  app2.post("/api/full-backups", requireAuth, requireAdmin, async (c) => {
    const body = await readJson(c);
    const origin = oneOf(body.origin ?? "manual", "origin", ["manual", "scheduled"]);
    const now = Date.now();
    const res = await c.env.DB.prepare(
      `INSERT INTO full_backups (r2_key, status, origin, file_count, original_size, level, created_at, user_id, device, note)
       VALUES ('', 'uploading', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      origin,
      int(body.fileCount ?? 0, "fileCount", { min: 0 }),
      int(body.originalSize ?? 0, "originalSize", { min: 0 }),
      body.level === void 0 ? null : int(body.level, "level", { min: 1, max: 22 }),
      now,
      c.get("user").id,
      deviceName(c),
      typeof body.note === "string" ? body.note.slice(0, 200) : null
    ).run();
    const id = Number(res.meta.last_row_id);
    await c.env.DB.prepare("UPDATE full_backups SET r2_key = ? WHERE id = ?").bind(fullKey(id), id).run();
    return c.json({ id, key: fullKey(id) });
  });
  app2.put("/api/full-backups/:id/data", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "Backup id", { min: 1 });
    const row = await c.env.DB.prepare("SELECT status FROM full_backups WHERE id = ?").bind(id).first();
    if (!row) throw notFound("That backup no longer exists.");
    if (row.status !== "uploading") throw conflict("That backup is already finished.");
    if (!c.req.raw.body) throw badRequest("Upload body is empty.");
    int(c.req.header("content-length"), "Content-Length header", { min: 1 });
    await c.env.BUCKET.put(fullKey(id), c.req.raw.body, { httpMetadata: { contentType: "application/zstd" } });
    return c.json({ ok: true });
  });
  app2.put("/api/full-backups/:id/manifest", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "Backup id", { min: 1 });
    const row = await c.env.DB.prepare("SELECT id FROM full_backups WHERE id = ?").bind(id).first();
    if (!row) throw notFound("That backup no longer exists.");
    const text = await c.req.text();
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.files)) throw new Error("files missing");
    } catch {
      throw badRequest('The manifest must be JSON with a "files" list.');
    }
    await c.env.BUCKET.put(manifestKey(id), text, { httpMetadata: { contentType: "application/json" } });
    return c.json({ ok: true });
  });
  app2.post("/api/full-backups/:id/complete", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "Backup id", { min: 1 });
    const body = await readJson(c);
    const row = await c.env.DB.prepare("SELECT * FROM full_backups WHERE id = ?").bind(id).first();
    if (!row) throw notFound("That backup no longer exists.");
    if (row.status !== "uploading") throw conflict("That backup is already finished.");
    const head = await c.env.BUCKET.head(row.r2_key);
    if (!head) throw new ApiError(409, "The archive was not uploaded.", "missing_data");
    const fileCount = body.fileCount === void 0 ? row.file_count : int(body.fileCount, "fileCount", { min: 0 });
    const originalSize = body.originalSize === void 0 ? row.original_size : int(body.originalSize, "originalSize", { min: 0 });
    await c.env.DB.prepare(
      "UPDATE full_backups SET status = 'complete', compressed_size = ?, file_count = ?, original_size = ?, completed_at = ? WHERE id = ?"
    ).bind(head.size, fileCount, originalSize, Date.now(), id).run();
    const policy = await loadPolicy(c.env.DB);
    const removed = await enforceFullRetention(c.env, policy.full.keep);
    await audit(c.env, c.get("user"), "full.completed", { id, fileCount, originalSize, compressedSize: head.size, origin: row.origin, removed });
    return c.json({ ok: true, compressedSize: head.size, removedOld: removed });
  });
  app2.post("/api/full-backups/:id/fail", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "Backup id", { min: 1 });
    const body = await readJson(c).catch(() => ({}));
    const row = await c.env.DB.prepare("SELECT * FROM full_backups WHERE id = ?").bind(id).first();
    if (!row) throw notFound("That backup no longer exists.");
    await c.env.BUCKET.delete([row.r2_key, manifestKey(id)]);
    await c.env.DB.prepare("UPDATE full_backups SET status = 'failed', note = ?, completed_at = ? WHERE id = ?").bind(typeof body.message === "string" ? body.message.slice(0, 300) : "Failed", Date.now(), id).run();
    return c.json({ ok: true });
  });
  app2.get("/api/full-backups/:id/manifest", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "Backup id", { min: 1 });
    const obj = await c.env.BUCKET.get(manifestKey(id));
    if (!obj) throw notFound("This backup has no file list.");
    return new Response(obj.body, { headers: { "content-type": "application/json" } });
  });
  app2.get("/api/full-backups/:id/download", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "Backup id", { min: 1 });
    const row = await c.env.DB.prepare("SELECT r2_key FROM full_backups WHERE id = ? AND status = 'complete'").bind(id).first();
    if (!row) throw notFound("That backup is not available.");
    const range = parseRange(c.req.header("range"));
    const obj = await c.env.BUCKET.get(row.r2_key, range ? { range } : void 0);
    if (!obj) throw notFound("The archive is missing from storage.");
    const headers = new Headers({ "content-type": "application/zstd", "accept-ranges": "bytes" });
    if (range) {
      const start = range.offset;
      const length = range.length ?? obj.size - start;
      headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
      headers.set("content-length", String(length));
      return new Response(obj.body, { status: 206, headers });
    }
    headers.set("content-length", String(obj.size));
    return new Response(obj.body, { headers });
  });
  app2.delete("/api/full-backups/:id", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "Backup id", { min: 1 });
    const row = await c.env.DB.prepare("SELECT id, r2_key FROM full_backups WHERE id = ?").bind(id).first();
    if (!row) throw notFound("That backup no longer exists.");
    await deleteFull(c.env, row);
    await audit(c.env, c.get("user"), "full.deleted", { id });
    return c.json({ ok: true });
  });
}
__name(registerFull, "registerFull");

// src/routes/admin.ts
function registerAdmin(app2) {
  app2.get("/api/settings", requireAuth, async (c) => c.json({ policy: await loadPolicy(c.env.DB) }));
  app2.put("/api/settings", requireAuth, requireAdmin, async (c) => {
    const body = await readJson(c);
    const policy = sanitizePolicy(body.policy ?? body);
    await savePolicy(c.env.DB, policy);
    await enforceFullRetention(c.env, policy.full.keep);
    await audit(c.env, c.get("user"), "settings.updated", policy);
    return c.json({ policy });
  });
  app2.get("/api/stats", requireAuth, async (c) => {
    const user = c.get("user");
    const db = c.env.DB;
    const since = Date.now() - 864e5;
    const [files, lastBatch, lastFull, fullAgg, blobAgg, versionsAgg, recent, users] = await db.batch([
      db.prepare("SELECT path, size FROM files WHERE deleted = 0"),
      db.prepare("SELECT id, started_at, finished_at, status, added, modified, deleted, message FROM batches WHERE status != 'running' ORDER BY id DESC LIMIT 1"),
      db.prepare("SELECT id, created_at, completed_at, compressed_size, original_size, file_count FROM full_backups WHERE status = 'complete' ORDER BY created_at DESC LIMIT 1"),
      db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(compressed_size), 0) AS bytes FROM full_backups WHERE status = 'complete'"),
      db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(stored_size), 0) AS bytes FROM blobs"),
      db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS earliest FROM versions"),
      db.prepare("SELECT path, op, created_at FROM versions WHERE created_at > ? ORDER BY id DESC LIMIT 5000").bind(since),
      db.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 0")
    ]);
    const visible = filterReadable(user, files.results);
    const recentVisible = filterReadable(user, recent.results);
    const isAdmin = user.role === "superadmin";
    const full = fullAgg.results[0];
    const blobs = blobAgg.results[0];
    const versions = versionsAgg.results[0];
    return c.json({
      files: visible.length,
      bytes: visible.reduce((s, f) => s + f.size, 0),
      lastSync: lastBatch.results[0] ?? null,
      lastFull: isAdmin ? lastFull.results[0] ?? null : null,
      fullBackups: isAdmin ? full.n : null,
      storedBytes: isAdmin ? blobs.bytes + full.bytes : null,
      versions: isAdmin ? versions.n : null,
      earliestVersion: versions.earliest,
      activeUsers: isAdmin ? users.results[0].n : null,
      recentChanges: recentVisible.map((r) => ({ path: r.path, op: r.op, at: r.created_at }))
    });
  });
  app2.get("/api/audit", requireAuth, requireAdmin, async (c) => {
    const limit = optionalInt(c.req.query("limit"), "limit", 100, { min: 1, max: 500 });
    const before = optionalInt(c.req.query("before"), "before", Number.MAX_SAFE_INTEGER, { min: 1 });
    const { results } = await c.env.DB.prepare("SELECT id, at, username, action, detail FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?").bind(before, limit).all();
    return c.json({ events: results });
  });
  app2.post("/api/maintenance", requireAuth, requireAdmin, async (c) => {
    const report = await runMaintenance(c.env);
    await audit(c.env, c.get("user"), "maintenance.run", report);
    return c.json(report);
  });
}
__name(registerAdmin, "registerAdmin");

// src/routes/auth.ts
var API_VERSION = "1.0.0";
var MAX_FAILED = 5;
var LOCK_MS = 5 * 60 * 1e3;
var USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,39}$/;
function validatePassword(value, name = "Password") {
  if (typeof value !== "string") throw badRequest(`${name} is required.`);
  if (value.length < 8) throw badRequest(`${name} must be at least 8 characters.`);
  if (value.length > 200) throw badRequest(`${name} is too long.`);
  return value;
}
__name(validatePassword, "validatePassword");
function validateUsername(value) {
  const u = str(value, "Username", { min: 2, max: 40 });
  if (!USERNAME_RE.test(u)) throw badRequest("Usernames can use letters, numbers, dots, dashes and underscores.");
  return u;
}
__name(validateUsername, "validateUsername");
async function superAdminExists(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'").first();
  return (row?.n ?? 0) > 0;
}
__name(superAdminExists, "superAdminExists");
function checkSetupKey(expected, given) {
  if (!expected) {
    throw new ApiError(503, 'The server has no SETUP_KEY configured. Set it with "wrangler secret put SETUP_KEY".', "setup_key_missing");
  }
  if (typeof given !== "string" || !constantTimeEqualText(given, expected)) throw forbidden("The setup key is not correct.");
}
__name(checkSetupKey, "checkSetupKey");
function registerAuth(app2) {
  app2.get("/api/health", async (c) => {
    return c.json({
      ok: true,
      service: "am-backup",
      version: API_VERSION,
      build: c.env.SERVER_BUILD ?? null,
      environment: c.env.APP_ENV,
      needsSetup: !await superAdminExists(c.env.DB),
      setupKeyConfigured: Boolean(c.env.SETUP_KEY),
      serverTime: Date.now()
    });
  });
  app2.post("/api/setup", async (c) => {
    const body = await readJson(c);
    checkSetupKey(c.env.SETUP_KEY, body.setupKey);
    if (await superAdminExists(c.env.DB)) throw conflict("The administrator account already exists. Sign in instead.");
    const username = validateUsername(body.username);
    const displayName = str(body.displayName, "Name", { max: 80, optional: true }) || "Administrator";
    const password = validatePassword(body.password);
    const now = Date.now();
    const res = await c.env.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, access, scope_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'superadmin', 'write', 'all', ?, ?)`
    ).bind(username, displayName, await hashPassword(password), now, now).run();
    const id = Number(res.meta.last_row_id);
    await audit(c.env, { id, username }, "setup.admin_created");
    const session = await createSession(c.env, id, deviceName(c));
    const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    return c.json({ token: session.token, expiresAt: session.expiresAt, user: await toAuthUser(c.env.DB, row) });
  });
  app2.post("/api/setup/reset-admin", async (c) => {
    const body = await readJson(c);
    checkSetupKey(c.env.SETUP_KEY, body.setupKey);
    const password = validatePassword(body.password, "New password");
    const admin = await c.env.DB.prepare("SELECT id, username FROM users WHERE role = 'superadmin' LIMIT 1").first();
    if (!admin) throw badRequest("There is no administrator account yet. Run the first-time setup instead.");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = 0, disabled = 0, updated_at = ? WHERE id = ?").bind(
        await hashPassword(password),
        Date.now(),
        admin.id
      ),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(admin.id)
    ]);
    await audit(c.env, admin, "setup.admin_password_reset");
    return c.json({ ok: true, username: admin.username });
  });
  app2.post("/api/auth/login", async (c) => {
    const body = await readJson(c);
    const username = str(body.username, "Username", { max: 40 });
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) throw badRequest("Enter your username and password.");
    const row = await c.env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    const now = Date.now();
    if (!row) {
      await dummyVerify(password);
      throw unauthorized("That username and password do not match.");
    }
    if (row.locked_until > now) {
      const mins = Math.ceil((row.locked_until - now) / 6e4);
      throw new ApiError(429, `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, "locked");
    }
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      const failed = row.failed_logins + 1;
      const lock = failed >= MAX_FAILED ? now + LOCK_MS : 0;
      await c.env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : failed, lock, row.id).run();
      if (lock) await audit(c.env, row, "auth.locked");
      throw unauthorized("That username and password do not match.");
    }
    if (row.disabled) throw forbidden("Your access has been revoked. Contact your administrator.");
    await c.env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = 0, last_login_at = ? WHERE id = ?").bind(now, row.id).run();
    const session = await createSession(c.env, row.id, deviceName(c));
    await audit(c.env, row, "auth.login", { device: deviceName(c) });
    return c.json({ token: session.token, expiresAt: session.expiresAt, user: await toAuthUser(c.env.DB, row) });
  });
  app2.post("/api/auth/logout", requireAuth, async (c) => {
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(c.get("tokenHash")).run();
    return c.json({ ok: true });
  });
  app2.get("/api/me", requireAuth, async (c) => {
    return c.json({ user: c.get("user"), policy: await loadPolicy(c.env.DB), serverTime: Date.now() });
  });
  app2.patch("/api/me", requireAuth, async (c) => {
    const me = c.get("user");
    const body = await readJson(c);
    const sets = [];
    const binds = [];
    if (body.displayName !== void 0) {
      sets.push("display_name = ?");
      binds.push(str(body.displayName, "Name", { min: 1, max: 80 }));
    }
    let passwordChanged = false;
    if (body.newPassword !== void 0) {
      const next = validatePassword(body.newPassword, "New password");
      const row2 = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(me.id).first();
      if (!row2 || !await verifyPassword(String(body.currentPassword ?? ""), row2.password_hash)) {
        throw badRequest("Your current password is not correct.");
      }
      sets.push("password_hash = ?");
      binds.push(await hashPassword(next));
      passwordChanged = true;
    }
    if (!sets.length) throw badRequest("Nothing to update.");
    sets.push("updated_at = ?");
    binds.push(Date.now(), me.id);
    const stmts = [c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds)];
    if (passwordChanged) stmts.push(c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(me.id, c.get("tokenHash")));
    await c.env.DB.batch(stmts);
    if (passwordChanged) await audit(c.env, me, "account.password_changed");
    const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(me.id).first();
    return c.json({ user: await toAuthUser(c.env.DB, row) });
  });
}
__name(registerAuth, "registerAuth");

// src/routes/users.ts
var ACCESS = ["read", "write"];
var SCOPES = ["all", "include", "exclude", "none"];
function parseFolders(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value)) throw badRequest("Folders must be a list.");
  if (value.length > 500) throw badRequest("Too many folders selected.");
  return compactFolders(value.map((v) => normalizeRelPath(v, "Folder")));
}
__name(parseFolders, "parseFolders");
async function listUsers(db) {
  const now = Date.now();
  const [users, paths, sessions] = await db.batch([
    db.prepare("SELECT * FROM users ORDER BY CASE role WHEN 'superadmin' THEN 0 ELSE 1 END, display_name COLLATE NOCASE"),
    db.prepare("SELECT user_id, path FROM user_paths ORDER BY path"),
    db.prepare("SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > ? GROUP BY user_id").bind(now)
  ]);
  const pathMap = /* @__PURE__ */ new Map();
  for (const p of paths.results) {
    const list = pathMap.get(p.user_id) ?? [];
    list.push(p.path);
    pathMap.set(p.user_id, list);
  }
  const sessionMap = new Map(sessions.results.map((s) => [s.user_id, s.n]));
  return users.results.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    access: u.role === "superadmin" ? "write" : u.access,
    scopeMode: u.role === "superadmin" ? "all" : u.scope_mode,
    paths: pathMap.get(u.id) ?? [],
    disabled: Boolean(u.disabled),
    locked: u.locked_until > now,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    lastLoginAt: u.last_login_at,
    activeSessions: sessionMap.get(u.id) ?? 0
  }));
}
__name(listUsers, "listUsers");
function pathStatements(db, userId, mode, folders) {
  const stmts = [db.prepare("DELETE FROM user_paths WHERE user_id = ?").bind(userId)];
  if (mode === "include" || mode === "exclude") {
    for (const f of folders) stmts.push(db.prepare("INSERT INTO user_paths (user_id, path) VALUES (?, ?)").bind(userId, f));
  }
  return stmts;
}
__name(pathStatements, "pathStatements");
function registerUsers(app2) {
  app2.get("/api/users", requireAuth, requireAdmin, async (c) => c.json({ users: await listUsers(c.env.DB) }));
  app2.post("/api/users", requireAuth, requireAdmin, async (c) => {
    const body = await readJson(c);
    const username = validateUsername(body.username);
    const displayName = str(body.displayName, "Name", { min: 1, max: 80 });
    const password = validatePassword(body.password);
    const access = oneOf(body.access ?? "read", "Access", ACCESS);
    const scopeMode = oneOf(body.scopeMode ?? "none", "Folder access", SCOPES);
    const folders = parseFolders(body.paths);
    if ((scopeMode === "include" || scopeMode === "exclude") && folders.length === 0) {
      throw badRequest(scopeMode === "include" ? "Choose at least one folder to share." : "Choose at least one folder to exclude.");
    }
    const exists = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
    if (exists) throw conflict(`The username "${username}" is already taken.`);
    const now = Date.now();
    const res = await c.env.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, role, access, scope_mode, created_at, updated_at)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`
    ).bind(username, displayName, await hashPassword(password), access, scopeMode, now, now).run();
    const id = Number(res.meta.last_row_id);
    await c.env.DB.batch(pathStatements(c.env.DB, id, scopeMode, folders));
    await audit(c.env, c.get("user"), "user.created", { id, username, access, scopeMode, folders });
    const users = await listUsers(c.env.DB);
    return c.json({ user: users.find((u) => u.id === id) }, 201);
  });
  app2.patch("/api/users/:id", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "User id", { min: 1 });
    const body = await readJson(c);
    const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    if (!row) throw notFound("That user no longer exists.");
    const isSuper = row.role === "superadmin";
    const sets = [];
    const binds = [];
    const stmts = [];
    let signOut = false;
    const changes = {};
    if (body.displayName !== void 0) {
      sets.push("display_name = ?");
      binds.push(str(body.displayName, "Name", { min: 1, max: 80 }));
      changes.displayName = true;
    }
    if (body.password !== void 0) {
      sets.push("password_hash = ?", "failed_logins = 0", "locked_until = 0");
      binds.push(await hashPassword(validatePassword(body.password)));
      signOut = true;
      changes.password = "reset";
    }
    if (body.unlock === true) {
      sets.push("failed_logins = 0", "locked_until = 0");
      changes.unlocked = true;
    }
    if (body.access !== void 0) {
      if (isSuper) throw forbidden("The administrator's access cannot be changed.");
      const access = oneOf(body.access, "Access", ACCESS);
      sets.push("access = ?");
      binds.push(access);
      changes.access = access;
    }
    if (body.disabled !== void 0) {
      if (isSuper) throw forbidden("The administrator account cannot be revoked.");
      const disabled = body.disabled === true;
      sets.push("disabled = ?");
      binds.push(disabled ? 1 : 0);
      if (disabled) signOut = true;
      changes.disabled = disabled;
    }
    if (body.scopeMode !== void 0 || body.paths !== void 0) {
      if (isSuper) throw forbidden("The administrator always has access to every folder.");
      const scopeMode = oneOf(body.scopeMode ?? row.scope_mode, "Folder access", SCOPES);
      const folders = parseFolders(body.paths ?? []);
      if ((scopeMode === "include" || scopeMode === "exclude") && folders.length === 0) {
        throw badRequest(scopeMode === "include" ? "Choose at least one folder to share." : "Choose at least one folder to exclude.");
      }
      sets.push("scope_mode = ?");
      binds.push(scopeMode);
      stmts.push(...pathStatements(c.env.DB, id, scopeMode, folders));
      changes.scopeMode = scopeMode;
      changes.folders = folders;
    }
    if (body.signOut === true) {
      signOut = true;
      changes.signedOut = true;
    }
    if (!sets.length && !stmts.length && !signOut) throw badRequest("Nothing to update.");
    if (sets.length) {
      sets.push("updated_at = ?");
      binds.push(Date.now(), id);
      stmts.unshift(c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds));
    }
    if (signOut) stmts.push(c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
    await c.env.DB.batch(stmts);
    await audit(c.env, c.get("user"), "user.updated", { id, username: row.username, ...changes });
    const users = await listUsers(c.env.DB);
    return c.json({ user: users.find((u) => u.id === id) });
  });
  app2.delete("/api/users/:id", requireAuth, requireAdmin, async (c) => {
    const id = int(c.req.param("id"), "User id", { min: 1 });
    const row = await c.env.DB.prepare("SELECT id, username, role FROM users WHERE id = ?").bind(id).first();
    if (!row) throw notFound("That user no longer exists.");
    if (row.role === "superadmin") throw forbidden("The administrator account cannot be deleted.");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM user_paths WHERE user_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id)
    ]);
    await audit(c.env, c.get("user"), "user.deleted", { id, username: row.username });
    return c.json({ ok: true });
  });
}
__name(registerUsers, "registerUsers");

// src/index.ts
var app = new Hono3();
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "X-Raw-Size", "X-Device", "Range"],
    exposeHeaders: ["Content-Length", "Content-Range", "X-Raw-Size"],
    maxAge: 86400
  })
);
app.get("/", (c) => c.text("AM Backup API is running."));
registerAuth(app);
registerUsers(app);
registerFiles(app);
registerFull(app);
registerAdmin(app);
registerTally(app);
app.notFound((c) => c.json({ error: "Not found.", code: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error("Unhandled error", err);
  return c.json({ error: "Something went wrong on the server. Please try again.", code: "internal" }, 500);
});
var index_default = {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runMaintenance(env).then(
        (report) => console.log("maintenance", JSON.stringify(report)),
        (err) => console.error("maintenance failed", err)
      )
    );
  }
};
export {
  index_default as default
};
