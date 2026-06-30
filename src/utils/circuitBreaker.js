/**
 * Circuit breaker pattern for protecting against cascading failures.
 * States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (testing recovery)
 */
const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' }

class CircuitBreaker {
  constructor({ threshold = 5, timeout = 30000, halfOpenRequests = 1 } = {}) {
    this.threshold = threshold
    this.timeout = timeout
    this.halfOpenRequests = halfOpenRequests
    this.state = STATE.CLOSED
    this.failures = 0
    this.successes = 0
    this.nextAttempt = Date.now()
  }

  async call(fn) {
    if (this.state === STATE.OPEN) {
      if (Date.now() < this.nextAttempt) throw new Error('Circuit open')
      this.state = STATE.HALF_OPEN
      this.successes = 0
    }
    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  onSuccess() {
    this.failures = 0
    if (this.state === STATE.HALF_OPEN) {
      this.successes++
      if (this.successes >= this.halfOpenRequests) this.state = STATE.CLOSED
    }
  }

  onFailure() {
    this.failures++
    if (this.failures >= this.threshold || this.state === STATE.HALF_OPEN) {
      this.state = STATE.OPEN
      this.nextAttempt = Date.now() + this.timeout
    }
  }

  get status() { return this.state }
}

module.exports = { CircuitBreaker }
