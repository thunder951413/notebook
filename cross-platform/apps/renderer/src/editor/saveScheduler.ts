export interface TrailingDebounce {
  /** Restart the timer; `run` fires once the input stays quiet for the delay. */
  call: () => void
  /** Run immediately if a call is pending, otherwise do nothing. */
  flush: () => void
  /** Drop any pending call without running. */
  cancel: () => void
}

export function createTrailingDebounce(delayMs: number, run: () => void): TrailingDebounce {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    call() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        run()
      }, delayMs)
    },
    flush() {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
      run()
    },
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
