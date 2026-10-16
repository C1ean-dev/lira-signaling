import test from 'node:test'
import assert from 'node:assert/strict'
import amqp from 'amqplib'

// Opt-in test against the configured account. Uses a private, temporary queue;
// it never advertises test rooms or sends messages to discovery subscribers.
test('CloudAMQP accepts TLS authentication and confirms a temporary publication', {
  skip: !process.env.CLOUDAMQP_TEST_URL,
  timeout: 20000,
}, async t => {
  let connection
  try {
    const endpoint = new URL(process.env.CLOUDAMQP_TEST_URL)
    assert.equal(endpoint.protocol, 'amqps:')
    connection = await amqp.connect(endpoint.toString(), { timeout: 7000 })
    connection.on('error', () => {})
    t.after(() => connection.close().catch(() => {}))
    const channel = await connection.createConfirmChannel()
    channel.on('error', () => {})
    const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true, durable: false })
    await new Promise((resolve, reject) => channel.sendToQueue(queue, Buffer.from('lira-discovery-connection-test'),
      { expiration: '10000', persistent: false }, error => error ? reject(error) : resolve()))
    const message = await channel.get(queue, { noAck: true })
    assert.equal(message.content.toString(), 'lira-discovery-connection-test')
  } catch {
    assert.fail('CloudAMQP TLS authentication or temporary publication failed (credentials redacted)')
  }
})
