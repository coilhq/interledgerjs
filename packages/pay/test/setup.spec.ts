/* eslint-disable prefer-const, @typescript-eslint/no-empty-function, @typescript-eslint/no-non-null-assertion */
import { StreamServer } from '@interledger/stream-receiver'
import { describe, expect, it, jest } from '@jest/globals'
import { createApp } from 'ilp-connector'
import { IlpError } from 'ilp-packet'
import { Connection, createServer, DataAndMoneyStream } from 'ilp-protocol-stream'
import { generatePskEncryptionKey, randomBytes } from 'ilp-protocol-stream/dist/src/crypto'
import {
  ConnectionAssetDetailsFrame,
  IlpPacketType,
  Packet,
} from 'ilp-protocol-stream/dist/src/packet'
import Long from 'long'
import nock from 'nock'
import { PaymentError, setupPayment } from '../src'
import { fetchPaymentDetails } from '../src/open-payments'
import { Int } from '../src/utils'
import {
  createMaxPacketMiddleware,
  createPlugin,
  createRateMiddleware,
  createSlippageMiddleware,
  createStreamReceiver,
  MirrorPlugin,
} from './helpers/plugin'
import { CustomBackend } from './helpers/rate-backend'
import reduct from 'reduct'

const streamServer = new StreamServer({
  serverSecret: randomBytes(32),
  serverAddress: 'private.larry',
})
const streamReceiver = createStreamReceiver(streamServer)
const uuid = () => '2646f447-542a-4f0a-a557-f7492b46265f'

describe('open payments', () => {
  const destinationAddress = 'g.wallet.receiver.12345'
  const sharedSecret = randomBytes(32)
  const sharedSecretBase64 = sharedSecret.toString('base64')

  it('quotes an invoice', async () => {
    const prices = {
      EUR: 1,
      USD: 1.12,
    }

    const plugin = createPlugin(
      createRateMiddleware({ code: 'EUR', scale: 3 }, { code: 'USD', scale: 4 }, prices),
      streamReceiver
    )

    const { ilpAddress, sharedSecret } = streamServer.generateCredentials()

    const invoiceId = uuid()
    const accountUrl = 'https://wallet.example/alice'
    const invoiceUrl = `${accountUrl}/invoices/${invoiceId}`
    const expiresAt = Date.now() + 60 * 60 * 1000 * 24 // 1 day in the future
    const description = 'Coffee'

    nock('https://wallet.example')
      .get(`/alice/invoices/${invoiceId}`)
      .matchHeader('Accept', 'application/ilp-stream+json')
      .reply(200, {
        id: invoiceUrl,
        account: accountUrl,
        amount: '45601',
        received: '2302', // Delivered: 2302 / 45601
        assetCode: 'USD',
        assetScale: 4,
        expiresAt: new Date(expiresAt).toISOString(),
        description,
        ilpAddress,
        sharedSecret: sharedSecret.toString('base64'),
      })

    const { startQuote: quote, ...destination } = await setupPayment({
      invoiceUrl,
      plugin,
    })
    const { minDeliveryAmount, minExchangeRate } = await quote({
      prices,
      sourceAsset: {
        code: 'EUR',
        scale: 4,
      },
    })

    // Tests that it quotes the remaining amount to deliver in the invoice
    expect(minExchangeRate).toBeDefined()
    expect(minDeliveryAmount.value).toBe(BigInt(45601 - 2302))
    expect(destination.invoice).toMatchObject({
      invoiceUrl,
      accountUrl,
      expiresAt,
      description,
      amountDelivered: Int.from(2302),
      amountToDeliver: Int.from(45601),
    })
    expect(destination.destinationAsset).toMatchObject({
      code: 'USD',
      scale: 4,
    })
    expect(destination.destinationAddress).toBe(ilpAddress)
    expect(destination.sharedSecret.equals(sharedSecret))
    expect(destination.accountUrl).toBe(accountUrl)
  })

  it('fails if invoice url is not HTTPS', async () => {
    await expect(
      fetchPaymentDetails({ invoiceUrl: 'http://this-is-a-wallet.co/invoice/123' })
    ).resolves.toBe(PaymentError.QueryFailed)
  })

  it('fails if given a payment pointer as an invoice url', async () => {
    await expect(fetchPaymentDetails({ invoiceUrl: '$foo.money' })).resolves.toBe(
      PaymentError.QueryFailed
    )
  })

  it('fails if the invoice was already paid', async () => {
    const invoiceId = uuid()
    const sharedSecret = randomBytes(32)
    const destinationAddress = 'g.larry.server3'

    const accountUrl = 'https://wallet.example/alice'
    const invoiceUrl = `${accountUrl}/invoices/${invoiceId}`

    nock('https://wallet.example')
      .get(`/alice/invoices/${invoiceId}`)
      .matchHeader('Accept', 'application/ilp-stream+json')
      .reply(200, {
        id: invoiceUrl,
        account: accountUrl,
        amount: '200',
        received: '203', // Paid $2.03 of $2 invoice
        assetCode: 'USD',
        assetScale: 2,
        expiresAt: new Date().toISOString(),
        description: 'Something really amazing',
        ilpAddress: destinationAddress,
        sharedSecret: sharedSecret.toString('base64'),
      })

    const { startQuote: quote } = await setupPayment({
      invoiceUrl,
      plugin: createPlugin(),
    })
    await expect(quote({})).rejects.toBe(PaymentError.InvoiceAlreadyPaid)
  })

  it('resolves and validates an invoice', async () => {
    const destinationAddress = 'g.wallet.users.alice.~w6247823482374234'
    const sharedSecret = randomBytes(32)
    const invoiceId = uuid()

    const accountUrl = 'https://wallet.example/alice'
    const invoiceUrl = `${accountUrl}/invoices/${invoiceId}`
    const expiresAt = Date.now() + 60 * 60 * 1000 * 24 // 1 day in the future
    const description = 'Coffee'

    const scope = nock('https://wallet.example')
      .get(`/alice/invoices/${invoiceId}`)
      .matchHeader('Accept', 'application/ilp-stream+json')
      .reply(200, {
        id: invoiceUrl,
        account: accountUrl,
        amount: '45601',
        received: '0',
        assetCode: 'USD',
        assetScale: 4,
        expiresAt: new Date(expiresAt).toISOString(),
        description,
        ilpAddress: destinationAddress,
        sharedSecret: sharedSecret.toString('base64'),
      })

    await expect(fetchPaymentDetails({ invoiceUrl })).resolves.toMatchObject({
      sharedSecret,
      destinationAddress,
      destinationAsset: {
        code: 'USD',
        scale: 4,
      },
      invoice: {
        amountDelivered: Int.ZERO,
        amountToDeliver: Int.from(45601),
        invoiceUrl,
        accountUrl,
        expiresAt,
        description,
      },
    })
    scope.done()
  })

  it('fails on invoice account mismatch', async () => {
    const accountUrl = 'https://wallet.example/alice'
    const invoiceUrl = `${accountUrl}/invoices/foo`

    const invoice = {
      id: invoiceUrl,
      amount: '100',
      received: '0',
      assetCode: 'USD',
      assetScale: 4,
      expiresAt: new Date(Date.now() + 600000000).toISOString(),
      description: 'Coffee',
      ilpAddress: 'g.wallet.users.alice.~w6247823482374234',
      sharedSecret: randomBytes(32).toString('base64'),
    }

    const scope1 = nock('https://wallet.example')
      .get('/alice/invoices/foo')
      .matchHeader('Accept', 'application/ilp-stream+json')
      .reply(200, {
        ...invoice,
        // Base URL is for a different account!
        account: 'https://wallet.example/bob',
      })
    await expect(fetchPaymentDetails({ invoiceUrl })).resolves.toBe(PaymentError.QueryFailed)
    scope1.done()

    const scope2 = nock('https://wallet.example')
      .get('/alice/invoices/foo')
      .matchHeader('Accept', 'application/ilp-stream+json')
      .reply(200, {
        ...invoice,
        // Base URL is an invalid accountURL/not HTTPS
        account: 'http://foo.bar',
      })
    await expect(fetchPaymentDetails({ invoiceUrl })).resolves.toBe(PaymentError.QueryFailed)
    scope2.done()
  })

  it('fails if invoice amounts are not positive and u64', async () => {
    const invoiceId = uuid()
    const accountUrl = 'https://wallet.example/alice'
    const invoiceUrl = `${accountUrl}/invoices/${invoiceId}`

    nock('https://wallet.example')
      .get(`/alice/invoices/${invoiceId}`)
      .matchHeader('Accept', 'application/ilp-stream+json')
      .reply(200, {
        id: invoiceUrl,
        account: accountUrl,
        amount: '100000000000000000000000000000000000000000000000000000000',
        received: -20,
        assetCode: 'USD',
        assetScale: 5,
        expiresAt: new Date().toISOString(),
        description: 'Something special',
        ilpAddress: 'private.foo',
        sharedSecret: Buffer.alloc(32),
      })

    await expect(fetchPaymentDetails({ invoiceUrl })).resolves.toBe(PaymentError.QueryFailed)
  })

  it('fails if invoice query times out', async () => {
    const scope = nock('https://money.example').get(/.*/).delay(6000).reply(500)
    await expect(fetchPaymentDetails({ invoiceUrl: 'https://money.example' })).resolves.toBe(
      PaymentError.QueryFailed
    )
    scope.done()
    nock.abortPendingRequests()
  })

  it('fails if invoice query returns 4xx error', async () => {
    const invoiceUrl = 'https://example.com/foo'
    const scope = nock('https://example.com').get('/foo').reply(404) // Query fails
    await expect(fetchPaymentDetails({ invoiceUrl })).resolves.toBe(PaymentError.QueryFailed)
    scope.done()
  })

  it('fails if invoice query response is invalid', async () => {
    // Validates invoice must be a non-null object
    const invoiceUrl = 'https://open.mywallet.com/invoices/123'
    const scope1 = nock('https://open.mywallet.com')
      .get('/invoices/123')
      .reply(200, '"not an invoice"')
    await expect(fetchPaymentDetails({ invoiceUrl })).resolves.toBe(PaymentError.QueryFailed)
    scope1.done()

    // Validates invoice must contain other details, not simply credentials
    const scope2 = nock('https://open.mywallet.com')
      .get('/invoices/123')
      .reply(200, {
        sharedSecret: randomBytes(32).toString('base64'),
        ilpAddress: 'private.larry.receiver',
      })
    await expect(fetchPaymentDetails({ invoiceUrl })).resolves.toBe(PaymentError.QueryFailed)
    scope2.done()
  })

  it('resolves credentials from an Open Payments account', async () => {
    const scope = nock('https://open.mywallet.com')
      .get('/accounts/alice')
      .matchHeader('Accept', /application\/ilp-stream\+json*./)
      .reply(200, {
        id: 'https://open.mywallet.com/accounts/alice',
        accountServicer: 'https://open.mywallet.com/',
        sharedSecret: sharedSecretBase64,
        ilpAddress: destinationAddress,
        assetCode: 'USD',
        assetScale: 6,
      })

    const credentials = await fetchPaymentDetails({
      paymentPointer: '$open.mywallet.com/accounts/alice',
    })
    expect(credentials).toMatchObject({
      sharedSecret,
      destinationAddress,
      destinationAsset: {
        code: 'USD',
        scale: 6,
      },
    })
    scope.done()
  })

  it('resolves credentials from SPSP', async () => {
    const scope = nock('https://alice.mywallet.com')
      .get('/.well-known/pay')
      .matchHeader('Accept', /application\/spsp4\+json*./)
      .delay(1000)
      .reply(200, {
        destination_account: destinationAddress,
        shared_secret: sharedSecretBase64,
        receiptsEnabled: false,
      })

    const credentials = await fetchPaymentDetails({ paymentPointer: '$alice.mywallet.com' })
    expect(credentials).toMatchObject({
      sharedSecret,
      destinationAddress,
      accountUrl: 'https://alice.mywallet.com/.well-known/pay',
    })
    scope.done()
  })

  it('fails if account query fails', async () => {
    const scope = nock('https://open.mywallet.com').get(/.*/).reply(500)
    await expect(fetchPaymentDetails({ paymentPointer: '$open.mywallet.com' })).resolves.toBe(
      PaymentError.QueryFailed
    )
    scope.done()
  })

  it('fails if account query times out', async () => {
    const scope = nock('https://open.mywallet.com').get(/.*/).delay(7000).reply(500)
    await expect(fetchPaymentDetails({ paymentPointer: '$open.mywallet.com' })).resolves.toBe(
      PaymentError.QueryFailed
    )
    scope.done()
    nock.abortPendingRequests()
  })

  it('fails if account query response is invalid', async () => {
    // Open Payments account not an object
    const scope1 = nock('https://example.com/foo').get(/.*/).reply(200, '"this is a string"')
    await expect(fetchPaymentDetails({ paymentPointer: '$example.com/foo' })).resolves.toBe(
      PaymentError.QueryFailed
    )
    scope1.done()

    // Invalid shared secret
    const scope2 = nock('https://alice.mywallet.com').get('/.well-known/pay').reply(200, {
      destination_account: 'g.foo',
      shared_secret: 'Zm9v',
    })
    await expect(fetchPaymentDetails({ paymentPointer: '$alice.mywallet.com' })).resolves.toBe(
      PaymentError.QueryFailed
    )
    scope2.done()

    // SPSP account not an object
    const scope3 = nock('https://wallet.example').get('/.well-known/pay').reply(200, '3')
    await expect(fetchPaymentDetails({ paymentPointer: '$wallet.example' })).resolves.toBe(
      PaymentError.QueryFailed
    )
    scope3.done()
  })

  it('follows SPSP redirect', async () => {
    const scope1 = nock('https://wallet1.example/').get('/.well-known/pay').reply(
      307, // Temporary redirect
      {},
      {
        Location: 'https://wallet2.example/.well-known/pay',
      }
    )

    const scope2 = nock('https://wallet2.example/')
      .get('/.well-known/pay')
      .matchHeader('Accept', /application\/spsp4\+json*./)
      .reply(200, { destination_account: destinationAddress, shared_secret: sharedSecretBase64 })

    const credentials = await fetchPaymentDetails({ paymentPointer: 'https://wallet1.example' })
    expect(credentials).toMatchObject({
      sharedSecret,
      destinationAddress,
    })
    scope1.done()
    scope2.done()
  })

  it('fails on SPSP redirect to non-HTTPS endpoint', async () => {
    const scope1 = nock('https://wallet1.example/').get('/.well-known/pay').reply(
      302, // Temporary redirect
      {},
      {
        Location: 'http://wallet2.example/.well-known/pay',
      }
    )

    const scope2 = nock('https://wallet2.example/').get('/.well-known/pay').reply(
      302, // Temporary redirect
      {},
      {
        Location: 'http://wallet3.example/.well-known/pay',
      }
    )

    await expect(fetchPaymentDetails({ paymentPointer: 'https://wallet1.example' })).resolves.toBe(
      PaymentError.QueryFailed
    )

    // Only the first request, should be resolved, ensure it doesn't follow insecure redirect
    expect(scope1.isDone())
    expect(!scope2.isDone())
  })

  it('fails if the payment pointer is semantically invalid', async () => {
    await expect(fetchPaymentDetails({ paymentPointer: 'ht$tps://example.com' })).resolves.toBe(
      PaymentError.InvalidPaymentPointer
    )
  })

  it('fails if query part is included', async () => {
    await expect(fetchPaymentDetails({ paymentPointer: '$foo.co?id=12345678' })).resolves.toBe(
      PaymentError.InvalidPaymentPointer
    )
  })

  it('fails if fragment part is included', async () => {
    await expect(fetchPaymentDetails({ paymentPointer: '$interledger.org#default' })).resolves.toBe(
      PaymentError.InvalidPaymentPointer
    )
  })

  it('fails if account URL is not HTTPS', async () => {
    await expect(
      fetchPaymentDetails({ paymentPointer: 'http://ilp.wallet.com/alice' })
    ).resolves.toBe(PaymentError.InvalidPaymentPointer)
  })

  it('validates given STREAM credentials', async () => {
    const sharedSecret = randomBytes(32)
    const destinationAddress = 'test.foo.~hello~world'
    await expect(fetchPaymentDetails({ sharedSecret, destinationAddress })).resolves.toMatchObject({
      sharedSecret,
      destinationAddress,
    })
  })

  it('fails if provided invalid STREAM credentials', async () => {
    await expect(
      fetchPaymentDetails({ sharedSecret: randomBytes(31), destinationAddress: 'private' })
    ).resolves.toBe(PaymentError.InvalidCredentials)
  })

  it('fails if no mechanism to fetch STREAM credentials was provided', async () => {
    await expect(fetchPaymentDetails({})).resolves.toBe(PaymentError.InvalidCredentials)
  })
})

describe('setup flow', () => {
  it('fails if given no payment pointer or STREAM credentials', async () => {
    await expect(
      setupPayment({
        plugin: new MirrorPlugin(),
      })
    ).rejects.toBe(PaymentError.InvalidCredentials)
  })

  it('fails given a semantically invalid payment pointer', async () => {
    await expect(
      setupPayment({
        plugin: new MirrorPlugin(),
        paymentPointer: 'ht$tps://example.com',
      })
    ).rejects.toBe(PaymentError.InvalidPaymentPointer)
  })

  it('fails if payment pointer cannot resolve', async () => {
    await expect(
      setupPayment({
        plugin: new MirrorPlugin(),
        paymentPointer: 'https://wallet.co/foo/bar',
      })
    ).rejects.toBe(PaymentError.QueryFailed)
  })

  it('fails if SPSP response is invalid', async () => {
    const scope = nock('https://example4.com').get('/foo').reply(200, { meh: 'why?' })

    await expect(
      setupPayment({
        plugin: new MirrorPlugin(),
        paymentPointer: 'https://example4.com/foo',
      })
    ).rejects.toBe(PaymentError.QueryFailed)
    scope.done()
  })

  it('establishes connection from SPSP and fetches asset details with STREAM', async () => {
    const [senderPlugin1, senderPlugin2] = MirrorPlugin.createPair()
    const [receiverPlugin1, receiverPlugin2] = MirrorPlugin.createPair()

    const app = createApp({
      ilpAddress: 'private.larry',
      backend: 'one-to-one',
      spread: 0,
      accounts: {
        sender: {
          relation: 'child',
          assetCode: 'ABC',
          assetScale: 0,
          plugin: senderPlugin2,
        },
        receiver: {
          relation: 'child',
          assetCode: 'XYZ',
          assetScale: 0,
          plugin: receiverPlugin1,
        },
      },
    })
    await app.listen()

    const streamServer = await createServer({
      plugin: receiverPlugin2,
    })

    const connectionHandler = jest.fn()
    streamServer.on('connection', connectionHandler)

    const scope = nock('https://example5.com')
      .get('/.well-known/pay')
      .matchHeader('Accept', /application\/spsp4\+json*./)
      .reply(() => {
        const credentials = streamServer.generateAddressAndSecret()

        return [
          200,
          {
            destination_account: credentials.destinationAccount,
            shared_secret: credentials.sharedSecret.toString('base64'),
          },
          { 'Content-Type': 'application/spsp4+json' },
        ]
      })

    const details = await setupPayment({
      paymentPointer: 'https://example5.com',
      plugin: senderPlugin1,
    })

    expect(details.destinationAsset).toMatchObject({
      code: 'XYZ',
      scale: 0,
    })

    // Connection should be able to be established after resolving payment pointer
    expect(connectionHandler.mock.calls.length).toBe(1)
    scope.done()

    await details.close()

    await app.shutdown()
    await streamServer.close()
  })

  it('fails on asset detail conflicts', async () => {
    const sharedSecret = randomBytes(32)
    const encryptionKey = await generatePskEncryptionKey(sharedSecret)

    // Create simple STREAM receiver that acks test packets,
    // but replies with conflicting asset details
    const plugin = createPlugin(async (prepare) => {
      const streamRequest = await Packet.decryptAndDeserialize(encryptionKey, prepare.data)
      const streamReply = new Packet(streamRequest.sequence, IlpPacketType.Reject, prepare.amount, [
        new ConnectionAssetDetailsFrame('ABC', 2),
        new ConnectionAssetDetailsFrame('XYZ', 2),
        new ConnectionAssetDetailsFrame('XYZ', 3),
      ])

      return {
        code: IlpError.F99_APPLICATION_ERROR,
        message: '',
        triggeredBy: '',
        data: await streamReply.serializeAndEncrypt(encryptionKey),
      }
    })

    await expect(
      setupPayment({
        plugin: plugin,
        destinationAddress: 'private.larry.receiver',
        sharedSecret,
      })
    ).rejects.toBe(PaymentError.DestinationAssetConflict)
  })

  it('fails on asset probe if cannot establish connection', async () => {
    const plugin = createPlugin(async () => ({
      code: IlpError.T01_PEER_UNREACHABLE,
      message: '',
      triggeredBy: '',
      data: Buffer.alloc(0),
    }))

    await expect(
      setupPayment({
        plugin,
        destinationAddress: 'private.larry.receiver',
        sharedSecret: Buffer.alloc(32),
      })
    ).rejects.toBe(PaymentError.EstablishmentFailed)
  }, 15_000)
})

describe('quoting flow', () => {
  it('fails if amount to send is not a positive integer', async () => {
    const asset = {
      code: 'ABC',
      scale: 4,
    }
    const { startQuote: quote } = await setupPayment({
      plugin: createPlugin(),
      destinationAsset: asset,
      destinationAddress: 'private.foo',
      sharedSecret: Buffer.alloc(32),
    })

    // Fails with negative source amount
    await expect(
      quote({
        amountToSend: BigInt(-2),
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSourceAmount)

    // Fails with fractional source amount
    await expect(
      quote({
        amountToSend: '3.14',
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSourceAmount)

    // Fails with 0 source amount
    await expect(
      quote({
        amountToSend: 0,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSourceAmount)

    // Fails with `NaN` source amount
    await expect(
      quote({
        amountToSend: NaN,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSourceAmount)

    // Fails with `Infinity` source amount
    await expect(
      quote({
        amountToSend: Infinity,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSourceAmount)

    // Fails with Int if source amount is 0
    await expect(
      quote({
        amountToSend: Int.ZERO,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSourceAmount)
  })

  it('fails if amount to deliver is not a positive integer', async () => {
    const asset = {
      code: 'ABC',
      scale: 4,
    }
    const { startQuote: quote } = await setupPayment({
      plugin: createPlugin(),
      destinationAsset: asset,
      destinationAddress: 'private.foo',
      sharedSecret: Buffer.alloc(32),
    })

    // Fails with negative source amount
    await expect(
      quote({
        amountToDeliver: BigInt(-3),
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidDestinationAmount)

    // Fails with fractional source amount
    await expect(
      quote({
        amountToDeliver: '3.14',
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidDestinationAmount)

    // Fails with 0 source amount
    await expect(
      quote({
        amountToDeliver: 0,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidDestinationAmount)

    // Fails with `NaN` source amount
    await expect(
      quote({
        amountToDeliver: NaN,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidDestinationAmount)

    // Fails with `Infinity` source amount
    await expect(
      quote({
        amountToDeliver: Infinity,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidDestinationAmount)

    // Fails with Int if source amount is 0
    await expect(
      quote({
        amountToDeliver: Int.ZERO,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidDestinationAmount)
  })

  it('fails if no invoice, amount to send or deliver was provided', async () => {
    const plugin = new MirrorPlugin()
    const asset = {
      code: 'ABC',
      scale: 3,
    }

    const { startQuote: quote } = await setupPayment({
      plugin,
      destinationAddress: 'private.receiver',
      destinationAsset: asset,
      sharedSecret: randomBytes(32),
    })
    await expect(
      quote({
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.UnknownPaymentTarget)
  })

  it('fails on quote if no test packets are delivered', async () => {
    const plugin = createPlugin(async () => ({
      code: IlpError.T01_PEER_UNREACHABLE,
      message: '',
      triggeredBy: '',
      data: Buffer.alloc(0),
    }))

    const asset = {
      code: 'USD',
      scale: 6,
    }

    const { startQuote: quote } = await setupPayment({
      plugin,
      destinationAddress: 'private.larry.receiver',
      destinationAsset: asset,
      sharedSecret: Buffer.alloc(32),
    })
    await expect(
      quote({
        amountToSend: '1000',
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.RateProbeFailed)
  }, 15_000)

  it('fails if max packet amount is 0', async () => {
    const destinationAddress = 'private.receiver'
    const sharedSecret = randomBytes(32)

    const plugin = createPlugin(createMaxPacketMiddleware(Int.ZERO))

    const { startQuote: quote } = await setupPayment({
      plugin,
      destinationAddress,
      destinationAsset: {
        code: 'ABC',
        scale: 0,
      },
      sharedSecret,
    })
    await expect(
      quote({
        amountToSend: 1000,
        sourceAsset: {
          code: 'ABC',
          scale: 0,
        },
      })
    ).rejects.toBe(PaymentError.ConnectorError)
  })

  it('fails if receiver never shared destination asset details', async () => {
    const plugin = createPlugin(streamReceiver)

    // Server will not reply with asset details since none were provided
    const credentials = streamServer.generateCredentials()

    await expect(
      setupPayment({
        plugin,
        destinationAddress: credentials.ilpAddress,
        sharedSecret: credentials.sharedSecret,
      })
    ).rejects.toBe(PaymentError.UnknownDestinationAsset)
  })

  it('fails if prices were not provided', async () => {
    const { sharedSecret, ilpAddress: destinationAddress } = streamServer.generateCredentials()

    const { startQuote: quote } = await setupPayment({
      plugin: createPlugin(),
      destinationAddress,
      destinationAsset: {
        code: 'GBP',
        scale: 0,
      },
      sharedSecret,
    })
    await expect(
      quote({
        amountToSend: 100,
        sourceAsset: {
          code: 'JPY',
          scale: 0,
        },
      })
    ).rejects.toBe(PaymentError.ExternalRateUnavailable)
  })

  it('fails if slippage is invalid', async () => {
    const asset = {
      code: 'ABC',
      scale: 2,
    }

    const { startQuote: quote } = await setupPayment({
      plugin: createPlugin(),
      sharedSecret: Buffer.alloc(32),
      destinationAddress: 'g.recipient',
      destinationAsset: asset,
    })

    await expect(
      quote({
        slippage: NaN,
        amountToSend: 10,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSlippage)

    await expect(
      quote({
        slippage: Infinity,
        amountToSend: 10,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSlippage)

    await expect(
      quote({
        slippage: 1.2,
        amountToSend: 10,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSlippage)

    await expect(
      quote({
        slippage: -0.0001,
        amountToSend: 10,
        sourceAsset: asset,
      })
    ).rejects.toBe(PaymentError.InvalidSlippage)
  })

  it('fails if source asset details are invalid', async () => {
    const asset = {
      code: 'ABC',
      scale: 2,
    }

    const { startQuote: quote } = await setupPayment({
      plugin: createPlugin(),
      sharedSecret: Buffer.alloc(32),
      destinationAddress: 'g.recipient',
      destinationAsset: asset,
    })

    await expect(
      quote({
        amountToSend: 10,
        sourceAsset: {
          code: 'ABC',
          scale: NaN,
        },
      })
    ).rejects.toBe(PaymentError.UnknownSourceAsset)

    await expect(
      quote({
        amountToSend: 10,
        sourceAsset: {
          code: 'KRW',
          scale: Infinity,
        },
      })
    ).rejects.toBe(PaymentError.UnknownSourceAsset)

    await expect(
      quote({
        amountToSend: 10,
        sourceAsset: {
          code: 'CNY',
          scale: -20,
        },
      })
    ).rejects.toBe(PaymentError.UnknownSourceAsset)

    await expect(
      quote({
        amountToSend: 10,
        sourceAsset: {
          code: 'USD',
          scale: 256,
        },
      })
    ).rejects.toBe(PaymentError.UnknownSourceAsset)
  })

  it('fails if no external price for the source asset exists', async () => {
    const { sharedSecret, ilpAddress: destinationAddress } = streamServer.generateCredentials({
      asset: {
        code: 'ABC',
        scale: 0,
      },
    })

    const plugin = createPlugin(streamReceiver)

    const { startQuote: quote } = await setupPayment({
      plugin,
      destinationAddress,
      sharedSecret,
    })
    await expect(
      quote({
        amountToSend: 100,
        sourceAsset: {
          code: 'some really weird currency',
          scale: 0,
        },
      })
    ).rejects.toBe(PaymentError.ExternalRateUnavailable)
  })

  it('fails if no external price for the destination asset exists', async () => {
    const { sharedSecret, ilpAddress: destinationAddress } = streamServer.generateCredentials({
      asset: {
        code: 'THIS_ASSET_CODE_DOES_NOT_EXIST',
        scale: 0,
      },
    })

    const plugin = createPlugin(streamReceiver)

    const { startQuote: quote } = await setupPayment({
      plugin,
      destinationAddress,
      sharedSecret,
    })
    await expect(
      quote({
        amountToSend: 100,
        sourceAsset: {
          code: 'USD',
          scale: 3,
        },
      })
    ).rejects.toBe(PaymentError.ExternalRateUnavailable)
  })

  it('fails if the external exchange rate is 0', async () => {
    const plugin = createPlugin(streamReceiver)

    const { sharedSecret, ilpAddress: destinationAddress } = streamServer.generateCredentials({
      asset: {
        code: 'XYZ',
        scale: 0,
      },
    })

    const { startQuote: quote } = await setupPayment({
      plugin,
      destinationAddress,
      sharedSecret,
    })
    await expect(
      quote({
        amountToSend: '1000',
        sourceAsset: {
          code: 'ABC',
          scale: 0,
        },
        prices: {
          // Computing this rate would be a divide-by-0 error,
          // so the rate is "unavailable" rather than quoted as 0
          ABC: 1,
          XYZ: 0,
        },
      })
    ).rejects.toBe(PaymentError.ExternalRateUnavailable)
  })

  it('fails it the probed rate is below the minimum rate', async () => {
    const plugin = createPlugin(createSlippageMiddleware(0.02), streamReceiver)

    const asset = {
      code: 'ABC',
      scale: 4,
    }

    const { sharedSecret, ilpAddress: destinationAddress } = streamServer.generateCredentials()

    const { startQuote: quote } = await setupPayment({
      plugin,
      destinationAddress,
      destinationAsset: asset,
      sharedSecret,
    })
    await expect(
      quote({
        amountToSend: '1000',
        sourceAsset: asset,
        slippage: 0.01,
      })
    ).rejects.toBe(PaymentError.InsufficientExchangeRate)
  })

  it('fails if the probed rate is 0', async () => {
    const sourceAsset = {
      code: 'BTC',
      scale: 8,
    }
    const destinationAsset = {
      code: 'EUR',
      scale: 0,
    }
    const prices = {
      BTC: 9814.04,
      EUR: 1.13,
    }

    const plugin = createPlugin(
      createMaxPacketMiddleware(Int.from(1000)!),
      createRateMiddleware(sourceAsset, destinationAsset, prices),
      streamReceiver
    )

    const { sharedSecret, ilpAddress: destinationAddress } = streamServer.generateCredentials()

    const { startQuote: quote } = await setupPayment({
      plugin,
      destinationAddress,
      destinationAsset,
      sharedSecret,
    })
    await expect(
      quote({
        amountToSend: '1000',
        sourceAsset,
        prices,
      })
    ).rejects.toBe(PaymentError.InsufficientExchangeRate)
  })

  it('fails if probed rate is very close to the minimum', async () => {
    const [senderPlugin1, senderPlugin2] = MirrorPlugin.createPair()
    const [receiverPlugin1, receiverPlugin2] = MirrorPlugin.createPair()

    const prices = {
      BTC: 9814.04,
      EUR: 1.13,
    }

    // Override with rate backend for custom rates
    let backend: CustomBackend
    const deps = reduct((Constructor) => Constructor.name === 'RateBackend' && backend)
    backend = new CustomBackend(deps)
    backend.setPrices(prices)

    const sourceAsset = {
      assetCode: 'BTC',
      assetScale: 8,
    }

    const app = createApp(
      {
        ilpAddress: 'private.larry',
        spread: 0.0005,
        accounts: {
          sender: {
            relation: 'child',
            plugin: senderPlugin2,
            maxPacketAmount: '1000',
            ...sourceAsset,
          },
          receiver: {
            relation: 'child',
            assetCode: 'EUR',
            assetScale: 6,
            plugin: receiverPlugin1,
          },
        },
      },
      deps
    )
    await app.listen()

    const streamServer = await createServer({
      plugin: receiverPlugin2,
    })

    const {
      sharedSecret,
      destinationAccount: destinationAddress,
    } = streamServer.generateAddressAndSecret()

    streamServer.on('connection', (conn: Connection) => {
      conn.on('stream', (stream: DataAndMoneyStream) => {
        stream.setReceiveMax(Long.MAX_UNSIGNED_VALUE)
      })
    })

    const { startQuote: quote } = await setupPayment({
      plugin: senderPlugin1,
      destinationAddress,
      sharedSecret,
    })
    await expect(
      quote({
        amountToSend: 100_000,
        sourceAsset: {
          code: 'BTC',
          scale: 8,
        },
        // Slippage/minExchangeRate is far too close to the real spread/rate
        // to perform the payment without rounding errors, since the max packet
        // amount of 1000 doesn't allow more precision.
        slippage: 0.0005001,
        prices,
      })
    ).rejects.toBe(PaymentError.InsufficientExchangeRate)

    await app.shutdown()
    await streamServer.close()
  })

  it('discovers precise max packet amount from F08s without metadata', async () => {
    const maxPacketAmount = 300324
    let largestAmountReceived = 0

    let numberOfPackets = 0

    const plugin = createPlugin(
      // Tests the max packet state transition from precise -> imprecise
      createMaxPacketMiddleware(Int.from(1_000_000)!),
      // Add middleware to return F08 errors *without* metadata
      // and track the greatest packet amount that's sent
      async (prepare, next) => {
        numberOfPackets++

        if (+prepare.amount > maxPacketAmount) {
          return {
            code: IlpError.F08_AMOUNT_TOO_LARGE,
            message: '',
            triggeredBy: '',
            data: Buffer.alloc(0),
          }
        } else {
          largestAmountReceived = Math.max(largestAmountReceived, +prepare.amount)
          return next(prepare)
        }
      },
      streamReceiver
    )

    const asset = {
      code: 'ABC',
      scale: 0,
    }

    const { sharedSecret, ilpAddress: destinationAddress } = streamServer.generateCredentials()

    const { startQuote: quote } = await setupPayment({
      plugin,
      sharedSecret,
      destinationAddress,
      destinationAsset: asset,
    })
    const { maxPacketAmount: discoveredMaxPacket } = await quote({
      amountToSend: 40_000_000,
      sourceAsset: asset,
    })

    // If STREAM did discover the max packet amount,
    // since the rate is 1:1, the largest packet the receiver got
    // should be exactly the max packet amount
    expect(largestAmountReceived).toBe(maxPacketAmount)
    expect(discoveredMaxPacket.toString()).toBe(maxPacketAmount.toString())

    // It should take relatively few packets to complete the binary search.
    // Checks against duplicate amounts being sent in parallel
    expect(numberOfPackets).toBeLessThan(40)
  }, 10_000)

  it('supports 1:1 rate with no max packet amount', async () => {
    const plugin = createPlugin(streamReceiver)
    const { sharedSecret, ilpAddress: destinationAddress } = streamServer.generateCredentials()
    const asset = {
      code: 'ABC',
      scale: 0,
    }

    const { startQuote: quote } = await setupPayment({
      plugin,
      sharedSecret,
      destinationAddress,
      destinationAsset: asset,
    })
    const { maxPacketAmount } = await quote({
      amountToSend: 10,
      sourceAsset: asset,
    })
    expect(maxPacketAmount.value).toBe(Int.MAX_U64.value)
  })
})