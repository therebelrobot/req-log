const ksuid = require('ksuid')
const Logger = require('@therebel/log')

module.exports = function reqLog ({ serviceName, logLevel, nodeEnv, stats }) {
  logger = Logger({ name: `${serviceName} [${nodeEnv}]`, level: logLevel, env: nodeEnv })
  return function (handler) {
    return function (req, res) {
      requestStart(req, res, logger, stats)
      return handler(req, res).then(
        (...args) => {
          requestFinish(req, res, logger, stats)
          return Promise.resolve(...args)
        },
        (err) => {
          requestFinish(req, res, logger, stats, err)
          return Promise.reject(err) // eslint-disable-line prefer-promise-reject-errors
        }
      )
    }
  }
}

function requestStart (req, res, logger, stats) {
  req.reqLogger = {}
  req.reqLogger.error = null
  req.reqLogger.start = Date.now()
  req.reqLogger.path = getNormalizedPathPattern(req)
  req.reqLogger.requestId = ksuid.randomSync().string
  logger.info('request', { method: req.method, path: req.url, id: req.reqLogger.requestId, query: req.query })
  res.setHeader('X-Request-ID', req.reqLogger.requestId)
}

function requestFinish (req, res, logger, stats, error) {
  if (error && error.statusCode) res.statusCode = error.statusCode
  else if (error) res.statusCode = 500 // thrown errors are caught further up the chain in micro
  else if (!res.statusCode) res.statusCode = 200 // normal responses are attached in micro too. only custom errors, like 400s, are present right now

  const code = res.statusCode / 100 | 0
  const duration = Date.now() - req.reqLogger.start
  const responseObject = {
    method: req.method,
    path: req.url,
    id: req.reqLogger.requestId,
    status: res.statusCode,
    query: req.query
  }
  if (stats) {
    const tags = [ `method:${req.method}`, `status:${res.statusCode}`, `statusGroup:${code}xx` ]

    // send out stats
    if (req.reqLogger.path) {
      tags.push(`route:${req.reqLogger.path}`)
      stats.histogram(`route_${req.method}_${req.reqLogger.path}`, duration)
    }

    // increment specific stats
    stats.incr(`response_status_${code}xx`, 1, tags)
    stats.incr(`response_status`, 1, tags)
    stats.histogram('response_duration', duration, tags)

    // warn on slow responses
    if (duration > 1000) {
      stats.incr('slow_response', 1, tags)
    }
    switch (code) {
      case 4: // 4xx client errors
        stats.incr('client_error', 1, tags)
      case 5: // 5xx server errors
        stats.incr('response_error', 1, tags)
    }
  }

  if (duration > 1000) {
    logger.warning('slow response', {
      url: req.url,
      id: req.reqLogger.requestId,
      method: req.method,
      duration,
      route: req.reqLogger.path || undefined
    })
  }
    // increment code-specific stats and return log response
  switch (code) {
    case 4: // 4xx client errors
      return logger.warning('response', responseObject)
    case 5: // 5xx server errors
      return logger.error('response', Object.assign({}, responseObject, { error }))
    default: // all other responses
      return logger.info('response', responseObject)
  }
}

function getNormalizedPathPattern (req) {
  if (req.url) return escapeSpecialCharacters(removeQuery(req.url))
  return null
}
function removeQuery (str) {
  if (str.indexOf('?') > -1) return str.split('?')[0]
  return str
}
function escapeSpecialCharacters (str) {
  return str.split(/[/:]/).filter(Boolean).join('_')
}
