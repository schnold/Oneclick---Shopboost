/**
 * Isolates a test run's queues from a running worker.
 *
 * Imported before anything that touches BullMQ. Without it, running a test
 * while `npm run worker` is up hands the test's fixture jobs to the real
 * worker, which tries to call Shopify for a shop that does not exist — the
 * test then fails for reasons that have nothing to do with the code.
 */
process.env.BULLMQ_PREFIX = "bull-shopboost-test";

export const TEST_QUEUE_PREFIX = process.env.BULLMQ_PREFIX;
