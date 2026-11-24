/**
 * DriverClient — newline-delimited JSON over a Unix socket to atspi_driver.py.
 *
 * One connection per request keeps the driver free of session state, and the
 * promise chain serialises calls per instance so two tool calls can never
 * interleave AT-SPI operations on the same display.
 *
 * @module dsh-ui-automation/driver
 */
import net from 'node:net'

/** Transport-level failure (socket missing, timeout, bad JSON). */
export class DriverTransportError extends Error {
  constructor(message, code = 'E_DRIVER_TRANSPORT') {
    super(message)
    this.code = code
  }
}

export class DriverClient {
  /**
   * @param {string} socketPath unix socket created by the managed shell
   */
  constructor(socketPath) {
    this.socketPath = socketPath
    this.seq = 0
    this.tail = Promise.resolve()
    this.closed = false
  }

  /**
   * Send one command. Resolves with the driver's response object, including
   * `ok: false` failures, so callers can surface structured errors.
   *
   * @param {string} cmd
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  request(cmd, params = {}, timeoutMs = 15_000) {
    const send = () => this.#send(cmd, params, timeoutMs)
    const result = this.tail.then(send, send)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  #send(cmd, params, timeoutMs) {
    if (this.closed) {
      return Promise.reject(new DriverTransportError('driver client is closed', 'E_CLOSED'))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let buffer = ''
      const socket = net.createConnection(this.socketPath)
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => {
        finish(new DriverTransportError(
          `driver did not answer "${cmd}" within ${timeoutMs}ms`,
          'E_DRIVER_TIMEOUT',
        ))
      }, timeoutMs)

      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id: ++this.seq, cmd, ...params })}\n`)
      })
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch (error) {
          finish(new DriverTransportError(`driver sent invalid JSON: ${error.message}`))
          return
        }
        finish(undefined, parsed)
      })
      socket.on('error', error => {
        finish(new DriverTransportError(
          `driver socket unavailable (${this.socketPath}): ${error.code || error.message}`,
          error.code === 'ENOENT' ? 'E_DRIVER_SOCKET' : 'E_DRIVER_TRANSPORT',
        ))
      })
      socket.on('close', () => {
        if (!settled) finish(new DriverTransportError('driver closed the connection', 'E_DRIVER_CLOSED'))
      })
    })
  }

  close() {
    this.closed = true
  }
}

/** Small promise delay. */
export function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, ms))
  })
}
