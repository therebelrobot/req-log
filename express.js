const ksuid = require('ksuid')
const minimatch = require('minimatch')
const { getNormalizedPathPattern, removeQuery, escapeSpecialCharacters } = require('./utils')

module.exports = ({logger, stats, ignore}) => (req, res, next) => {
  res.on('finish', requestFinish({req, res, logger, stats, ignore}));
  requestStart({req, res, logger, stats, ignore})
  next()
}

function requestStart ({ req, res, logger, stats, ignore }) {
  if (ignore && minimatch(req.path, ignore)) return
  req.reqLogger = {}
  req.reqLogger.error = null
  req.reqLogger.start = Date.now()
  req.reqLogger.path = getNormalizedPathPattern(req)
  req.reqLogger.requestId = ksuid.randomSync().string
  logger.info(`⠿⠿ request ${req.reqLogger.requestId}`, { method: req.method, path: req.url, id: req.reqLogger.requestId, query: req.query })
  res.setHeader('X-Request-ID', req.reqLogger.requestId)
}

function requestFinish ({ req, res, logger, stats, error, ignore }) {
  return (...args) => {
    if (ignore && minimatch(req.path, ignore)) return
    const code = res._header ? (res.statusCode / 100 | 0) : 5;
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
        return logger.warning(`🛑  response ${req.reqLogger.requestId}`, responseObject)
      case 5: // 5xx server errors
        return logger.error(`💥  response ${req.reqLogger.requestId}`, Object.assign({}, responseObject, { error }))
      default: // all other responses
        return logger.info(`✅  response ${req.reqLogger.requestId}`, responseObject)
    }
  }
}
