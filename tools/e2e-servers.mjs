// Starts the test relay and the mock LLM for e2e runs.
import { startRelay } from './relay.mjs'
import { startMockLLM } from './mock-llm.mjs'
startRelay(7777)
startMockLLM(7790)
console.log('e2e servers ready')
setInterval(() => {}, 1 << 30)
