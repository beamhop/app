// The polyfill packages the Node layer is built on, imported in one place.
// The trailing slash in 'buffer/', 'events/', … is Node's convention for "the npm package, not the built-in":
// without it a Node host (tests, the bridge) would silently run on its own built-ins instead of the code the
// browser gets. The packages are untyped or typed for a different implementation, hence Dyn.
import assertImpl from 'assert/'
import { Buffer as BufferImpl, INSPECT_MAX_BYTES as inspectMax, kMaxLength as maxLength, SlowBuffer as SlowBufferImpl } from 'buffer/'
import eventsImpl from 'events/'
import pathImpl from 'path-browserify'
import punycodeImpl from 'punycode/'
import querystringImpl from 'querystring-es3'
import streamImpl from 'readable-stream'
import { StringDecoder as StringDecoderImpl } from 'string_decoder/'
import urlImpl from 'url/'
import utilImpl from 'util/'
import type { Dyn } from './types.js'

export const assertPkg: Dyn = assertImpl
export const BufferPkg: Dyn = BufferImpl
export const SlowBufferPkg: Dyn = SlowBufferImpl
export const kMaxLength: number = maxLength
export const INSPECT_MAX_BYTES: number = inspectMax
export const EventEmitterPkg: Dyn = eventsImpl
export const pathPkg: Dyn = pathImpl
export const punycodePkg: Dyn = punycodeImpl
export const querystringPkg: Dyn = querystringImpl
export const streamPkg: Dyn = streamImpl
export const StringDecoderPkg: Dyn = StringDecoderImpl
export const urlPkg: Dyn = urlImpl
export const utilPkg: Dyn = utilImpl
