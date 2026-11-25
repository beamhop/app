// Test PKI, generated in memory at test time. Nothing here is written to disk or committed.
import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { webcrypto } from 'node:crypto'

const subtle = webcrypto.subtle as unknown as SubtleCrypto
x509.cryptoProvider.set(webcrypto as unknown as Crypto)

export type KeyAlg = 'p256' | 'p384' | 'p521' | 'rsa' | 'ed25519'

const ALGS: Record<KeyAlg, RsaHashedKeyGenParams | EcKeyGenParams | Algorithm> = {
  p256: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as EcKeyGenParams,
  p384: { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-384' } as EcKeyGenParams,
  p521: { name: 'ECDSA', namedCurve: 'P-521', hash: 'SHA-512' } as EcKeyGenParams,
  rsa: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  ed25519: { name: 'Ed25519' },
}

export interface Issued {
  alg: KeyAlg
  keys: CryptoKeyPair
  cert: x509.X509Certificate
  /** PEM certificate. */
  pem: string
  /** PEM PKCS#8 private key (in memory only). */
  key: string
  der: Uint8Array
}

export interface IssueOptions {
  cn: string
  alg?: KeyAlg
  /** DNS names and IP literals for subjectAltName. Default: [cn]. Pass [] for no SAN extension. */
  sans?: string[]
  /** Make it a CA certificate. */
  ca?: boolean
  notBefore?: Date
  notAfter?: Date
  eku?: string[]
  /** Issuer; omitted = self-signed. */
  issuer?: Issued
}

const DAY = 86400_000
let serial = 1
export const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'
export const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'

export async function issue(o: IssueOptions): Promise<Issued> {
  const alg = o.alg ?? 'p256'
  const keys = (await subtle.generateKey(ALGS[alg], true, ['sign', 'verify'])) as CryptoKeyPair
  const signer = o.issuer ?? { alg, keys }
  const sans = o.sans ?? [o.cn]
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(!!o.ca, undefined, true),
    new x509.KeyUsagesExtension(o.ca ? x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign : x509.KeyUsageFlags.digitalSignature, true),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
  ]
  if (!o.ca) extensions.push(new x509.ExtendedKeyUsageExtension(o.eku ?? [SERVER_AUTH]))
  if (!o.ca && sans.length > 0) extensions.push(new x509.SubjectAlternativeNameExtension(sans.map((v) => ({ type: /^[\d.]+$|:/.test(v) ? 'ip' : 'dns', value: v }) as x509.JsonGeneralName)))
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: (serial++).toString(16).padStart(2, '0'),
    subject: `CN=${o.cn}`,
    issuer: o.issuer ? o.issuer.cert.subject : `CN=${o.cn}`,
    notBefore: o.notBefore ?? new Date(Date.now() - DAY),
    notAfter: o.notAfter ?? new Date(Date.now() + 30 * DAY),
    signingAlgorithm: ALGS[signer.alg],
    publicKey: keys.publicKey,
    signingKey: signer.keys.privateKey,
    extensions,
  })
  const pkcs8 = Buffer.from(await subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')
  const key = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
  return { alg, keys, cert, pem: cert.toString('pem') + '\n', key, der: new Uint8Array(cert.rawData) }
}

export function derToPem(der: Uint8Array): string {
  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
}
