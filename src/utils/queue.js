/**
 * Async queue with concurrency control.
 * Prevents overwhelming downstream services by limiting parallel work.
 */
class AsyncQueue {
  constructor(concurrency = 3) {
    this.concurrency = concurrency
    this.running = 0
    this.queue = []
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject })
      this.drain()
    })
  }

  async drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift()
      this.running++
      try {
        const result = await fn()
        resolve(result)
      } catch (err) {
        reject(err)
      } finally {
        this.running--
        this.drain()
      }
    }
  }

  get pending() { return this.queue.length }
  get active()  { return this.running }
}

module.exports = { AsyncQueue }
