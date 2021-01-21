// HTTPNS is an EventEmitter.
import { EventEmitter } from 'events'

// We'll need some connection creation functions.
import { createSecureContext }  from 'tls'
import { createConnection }     from 'net'
import { createServer as publicServer }     from 'net'
import { createServer as privateServer }    from 'https'

// I'd prefer only the ones I need, but I don't wanna promisify them myself.
import { promises as fs } from 'fs'

// We're gonna play HTTP server for a sec.
import { STATUS_CODES } from 'http'

// Keep object-specific options private but accessable, so we can't accidently override anything stupid.
const priv = Symbol('options')

// The HTTPNS object.
class HTTPNS extends EventEmitter {
    constructor(port = 6110, path = '.https-sock') {
        // Build EventEmitter
        super()

        // Domains the object will be supporting.
        const domains = {}

        // Build the HTTP server we'll be listening on.
        const http = publicServer(socket => socketForwarder(this, socket))

        // Build the HTTPS server we'll be listening on.
        const SNICallback = (domain, cb) => SNICallbacks(this, domain, cb)
        const https = privateServer({ SNICallback }, (req, res) => requestForwarder(this, req, res))

        // Bind options that can't be changed while server is running.
        this[priv] = { port, path, https, http, domains }

        // Make sure path is correct.
        this.path = path

        // Start the servers.
        this.start()
    }

    // Get status of the server.
    get running() { return (this.https && this.https.listening) && (this.http && this.http.listening) }

    // Getter for Port.
    get port()  { return this[priv].port }
    get path()  { return this[priv].path }
    
    // Getters for http/s
    get http()  { return this[priv].http }
    get https() { return this[priv].https }

    // Setter for Port.
    set port(val) {
        // Error checking.
        if(this.running)    throw new Error('Cannot assign port while servers are running.')
        else if(isNaN(val)) throw new Error('Assigned port must be a number.')
        // Assign the value sheesh.
        else this[priv].port = val
    }

    // Setter for path.
    set path(val) { 
        // Error checking.
        if(this.running) throw new Error(`Cannot assign path while server is running.`)
        // Assign the appropriate path.
        else this[priv].path = `${process.platform === "win32" && !val.startsWith('\\\\?\\pipe\\') ? "\\\\?\\pipe\\" : "" }${val}` 
    }

    // Fetch a domain emitter object.
    as(domain, context = false) { if(this[priv].domains[domain]) return context ? this[priv].domains[domain].context : this[priv].domains[domain].emitter }

    // Check if a domain is supported.
    has(domain) { return Boolean(this[priv].domains[domain]) }

    // Register a domain to serve.
    register(...opts) {
        // Get an array of results.
        const results = opts.map(opt => {
            // Create a result to return.
            this[priv].domains[opt.domain] = { emitter: new EventEmitter, context: opt.context }

            // If we've been supplied a context to look-up.
            if(!opt.context) register(this, opt)

            // Return the result.
            const domain    = opt.domain
            const emitter   = this[priv].domains[opt.domain].emitter

            // Everything is going according to plan.
            return { domain, emitter }
        })

        // If there's only one, return the object directly.
        return results.length === 1 ? results[0] : results
    }

    // Start the server.
    async start() {
        // Check to see if the socket file already exists.
        const stat = await fs.stat(this.path).catch(e => { console.error(e); return null })

        // If the socket file existed before the process started, assume unclean shutdown and clean up the mess.
        if(stat) {
            // Get the time this process started.
            const init = new Date
            init.setSeconds(init.getSeconds() - process.uptime())
            
            // Clean up old socket file.
            if(stat.birthtime.getTime() < init.getTime()) await fs.unlink(this.path).catch(e => { console.error(e); return null })
        }

        // Start the servers.
        this.http.listen(this.port)
        this.https.listen({ path: this.path })

        // Forward individual errors to main object.
        this.http.on('error', err => this.emit('error', err))
        this.https.on('error', err => this.emit('error', err))
    }

    // Stop the servers.
    stop() { this.http.close(); this.https.close() }
}

// Handle SNIContext crawling.
function SNICallbacks(httpns, domain, cb) {
    // This context references another domain, load it.
    if(typeof httpns.as(domain, true) === "string") { httpns[priv].domains[domain].context = httpns.as(httpns.as(domain, true), true) }

    // Fetch the context.
    const context = httpns.as(domain, true)

    // Domain is supported.
    if(context) cb(null, context)
    else cb(new Error(`Unsupported domain ${domain}`))
}

// Create HTTP Header response quick and easy.
function headers(code, data = {}) {
    const header = []
    // Add HTTP version and code response header.
    header.push(`HTTP/1.1 ${code} ${STATUS_CODES[code]}`)

    // Apply supplied headers.
    Object.keys(data).forEach(key => header.push(`${key}: ${data[key]}`))
    return header.join('\r\n') + "\r\n\r\n"
}

// Handle HTTPS requests.
function requestForwarder(httpns, req, res) {
    // Emit the event under the domain emitter.
    httpns.as(req.headers.host).emit(req.url, res, req)

    // Emit a catch all under request.
    httpns.emit('request', req.headers.host, res, req)

    // Set a timeout to kill the request if nothing answers it.
    setTimeout(() => {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end("Error 500: No request handler.")
    }, 5000)
}

// Socket Forwarder.
function socketForwarder(httpns, socket) {
    // Identify the socket data and handle appropriately.
    socket.once('data', data => {
        // HTTPS connection, forward it to the HTTPS server.
        if(data[0] === 22) {
            // Connect to HTTPS.
            const conn = createConnection({ path: httpns.path })

            // Pipe connections together.
            socket.pipe(conn)
            conn.pipe(socket)

            // Forward initial connection packet.
            conn.write(data)

            // Do some quick cleanup. We don't need errors between these two crashing us all. I'm not running a Trump administration up in here.
            conn.once('error',      () => conn.end())
            conn.once('end',        () => socket.end())
            socket.once('error',    () => socket.end())
            socket.once('end',      () => conn.end())
        }

        // This isn't an HTTPS request.
        else {
            // Parse the data for easier reading.
            const parse = data.toString().trim().split('\r\n')

            // Split out the domain and request.
            if(parse.length > 1) {
                const domain    = parse[1].substring(parse[1].indexOf(' ') + 1)
                const url       = parse[0].substring(parse[0].indexOf(' ') + 1, parse[0].lastIndexOf(' '))

                // Check if the domain is supported by the server, if so, return 308 redirect to HTTPS.
                if(httpns.has(domain)) {
                    socket.write(headers(308, { 'Content-Type': 'text/plain', 'Location': `https://${domain}${url}`, 'Connection': 'closed' }))
                    return socket.end("Response 308: Redirecting to secured request.")
                }
            }

            // We haven't sorted the connection. We'll just return HTTP errors to annoy them.
            socket.write(headers(400, { "Content-Type": 'text/plain', 'Connection': 'closed' }))
            socket.end(`Error 400: Unknown domain; Domain incorrectly pointing to this server.`)
        }
    })
}

// Read files to create a secureContext.
async function register(httpns, opts) {
    // Try and read key/cert files.
    const key   = await fs.readFile(opts.key).catch(err =>  { console.error(err); return null })
    const cert  = await fs.readFile(opts.cert).catch(err => { console.error(err); return null })

    // Attempt to create the secureContext
    const context = (key && cert) ? createSecureContext({ key, cert }) : null

    // Check if we have a context.
    if(context) {
        // Assign emitter.
        httpns[priv].domains[opts.domain].context = context
        // Emit registry event.
        httpns.emit('registry', opts.domain, httpns[priv].domains[opts.domain].emitter)
    }

    // An error has occurred.
    else httpns.emit('error', new Error(`Could not create secureContext for ${opts.domain}.`))
}

// Export HTTPNS object.
export { HTTPNS }