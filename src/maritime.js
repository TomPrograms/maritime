const http = require("http");
const https = require("https");
const middlewareCompiler = require("./middleware/middlewareCompiler.js");
const dataObj = require("./data/data.js");
const requestObj = require("./data/req.js");
const responseObj = require("./data/res.js");
const maritimeRouter = require("./router/router.js");
const url = require("url");
const fs = require("fs");

module.exports = class Maritime {
  constructor(options = {}) {
    this.globalMiddleware = [];
    this.mountedRouters = [];

    this.dataObj = Object.create(dataObj);
    this.requestObj = Object.create(requestObj);
    this.responseObj = Object.create(responseObj);

    this.env = options.env || process.env.NODE_ENV || "development";
    this.settings = {};
    if (options.keys) this.keys = options.keys;
    this.proxy = options.proxy || false;
    this.proxyHeader = options.proxyHeader || "X-Forwarded-For";

    // don't enable x-powered-by header in production mode for security
    this.set("x-powered-by", this.env !== "production");
  }

  /**
   * Sets value to this.settings based on provided key and value.
   * Values set can be retrieved through get(key).
   *
   * @param {String} [setting] Key to use when adding value to this.settings.
   * @param {String} [val] Value to set in this.settings.
   */
  set(setting, val) {
    this.settings[setting] = val;
  }

  /**
   * Returns this.settings value for provided key (usually set through .get(key, value)).
   *
   * @param {String} [setting] Key to find the value of in this.settings.
   * @return this.settings value for key provided.
   */
  get(setting) {
    return this.settings[setting];
  }

  /**
   * Add a global middleware function to be run during every request. Global
   * middleware are run before route specific middleware.
   *
   * @param {Function} [middleware] Middleware function to add to global middleware.
   */
  use(middleware) {
    if (typeof middleware !== "function")
      throw new Error("Middleware provided with .use() must be a function.");

    this.globalMiddleware.push(middleware);
  }

  /**
   * Mount a router to the app to match routes.
   *
   * @param {String=} [baseRoute] Path to preface all routes with.
   * @param {...Function=} [middleware] List of middleware to add to all routes.
   * @param {Object} [router] Actual router object to use to match routes.
   */
  mount(...args) {
    let baseRoute, middleware, router;
    // if first argument is a string, a route should be applied to absorbed router
    if (typeof args[0] == "string") {
      baseRoute = args[0];

      // if first is base route, and the second argument is function,
      // the second argument to second to last is all middleware
      if (typeof args[1] == "function")
        middleware = args.slice(1, args.length - 2);
      router = args[args.length - 1];
    }

    // if first argument is function, all but last argument is middleware
    else if (typeof args[0] == "function") {
      middleware = args.slice(0, args.length - 2);
      router = args[args.length - 1];
    }

    // else, just a router was provided
    else {
      router = args[0];
    }

    // check a maritime router object is provided
    if (!router instanceof maritimeRouter)
      throw new Error(
        "Only maritime routers can be mounted for use with maritime."
      );

    // apply options to router before mounting
    if (baseRoute !== undefined) router = router.rebaseRouter(baseRoute);
    if (middleware !== undefined) {
      router.use(undefined, middleware);
    }

    // if routing engine added to app, apply it to the router
    let routingEngine = this.get("routing-engine");
    if (routingEngine) router.applyRoutingEngine(routingEngine);

    // activate routing engine
    router.createRegex();

    // mount router
    this.mountedRouters.push(router);
  }

  handleServer() {
    // function to pass to http server
    const serverFunction = function(req, res) {
      const data = this.constructData(req, res);
      return this.handleRequest(data);
    };

    // bind this object to the function so when it is ran inside the HTTP
    // server, the function can still access methods inside this object
    return serverFunction.bind(this);
  }

  findRouteMatch(path, method) {
    let match;
    for (let i = 0; i < this.mountedRouters.length; i++) {
      match = this.mountedRouters[i].findRoute(path, method.toLowerCase());
      if (match) {
        let returnData = {
          route: match,
          router: this.mountedRouters[i]
        };
        return returnData;
      }
    }
  }

  handleRequest(data) {
    // compile global middleware
    const globalMiddleware = middlewareCompiler(this.globalMiddleware);

    const executeRouteFuncs = function(data) {
      // match a route
      let path = data.req.strippedPath;
      let method = data.req.method;

      const matchData = this.findRouteMatch(path, method);

      // compile router specific middleware
      if (matchData) {
        data.req.params = matchData.route.params;

        let routerMiddleware = middlewareCompiler(matchData.router.middleware);
        const runRouteFuncs = function(data) {
          let routeMiddleware = middlewareCompiler(matchData.route.middleware);
          routeMiddleware(data);
        }.bind(this);

        routerMiddleware(data, runRouteFuncs);
      }
    }.bind(this);

    globalMiddleware(data, executeRouteFuncs);
  }

  constructData(req, res) {
    const data = Object.create(this.dataObj);

    // create request and response objects
    const request = Object.setPrototypeOf(req, this.requestObj);
    const response = Object.setPrototypeOf(res, this.responseObj);

    // add objects to each other
    request.app = response.app = this;
    request.res = response;
    response.req = request;

    // set x-powered-by header
    if (this.get("x-powered-by") === true)
      res.setHeader("X-Powered-By", "Maritime");

    request.strippedPath = url.parse(req.url).pathname;

    // add objects to data object
    data.req = request;
    data.res = response;
    data.app = this;

    return data;
  }

  /**
   * @param {Number} [port] Port number to run the server on
   * @param {Object=} [options] Server options
   * @param {String} [option.key] Key to use for HTTPS server, can be key data or file to load
   * @param {String} [option.cert] Cert to use for HTTPS server, can be key data or file to load
   * @param {String} [options.hostname] Specifies the IP address we want to listen to
   * @param {Number} [options.backlog] Specifies the max length of the queue of pending connections
   * @param {Function=} [callback] Callback to run after server is created
   *
   * @returns HTTP/HTTPS server
   */
  listen(...args) {
    let port, options, callback;
    if (typeof args[1] == "function") {
      port = args[0];
      callback = args[1];
      options = {};
    } else {
      port = args[0];
      options = args[1] || {};
      callback = args[2];
    }

    const secureServer = options.https === true;

    const checkToLoad = function(data) {
      if (!data) return data;
      if (data.includes(".pem")) return fs.readFileSync(data);
      return data;
    };

    let serverObj;
    if (secureServer) {
      const httpConfig = {
        key: checkToLoad(options.key),
        cert: checkToLoad(options.cert)
      };
      serverObj = https.createServer(httpConfig, this.handleServer());
    } else {
      serverObj = http.createServer(this.handleServer());
    }

    return serverObj.listen(port, options.hostname, options.backlog, callback);
  }
};
