import http from 'http';
import crypto from 'crypto';
import fs from 'fs/promises';

const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 3000;
const users_file = process.env.USERS_FILE || './users.json';
const coturn_secret = process.env.COTURN_SECRET || '';

const hosts: {
    [id: string]: {
        hostDescription: string,
        hostCandidates: string[],
        guestDescription: string,
        guestCandidates: string[],
        hostAccessKey: string,
        guestAccessKey: string,
        updated: Date
    }
} = {};

function coturnCredentials(user: string, ok: boolean) {
    if (!ok) {
        return {
            username: 'username',
            credential: 'willnotwork'
        }
    }

    const expiry = Math.floor(Date.now() / 1000) + 600;
    const username = `${expiry}:${user}`;
    const credential = crypto
        .createHmac('sha1', coturn_secret)
        .update(username)
        .digest('base64');
    return {
        username: username,
        credential: credential
    };
}

function encodedStorage(user: string, ok: boolean) {
    const userCredential = coturnCredentials(user, ok);
    const iceServers = (ok: boolean) => {
        if (ok) {
            return [
                { urls: ['stun:u.matrix.am:3478'] },
                {
                    urls: ['turns:u.matrix.am:3478?transport=udp'],
                    username: userCredential.username,
                    credential: userCredential.credential
                }
            ];
        } else {
            return [];
        }
    };

    const storage = {
        rooms: [],
        rtcConfiguration: {
            iceServers: iceServers(ok),
            iceTransportPolicy: 'all'
        },
        signalServer: ''
    };
    return Buffer.from(JSON.stringify(storage)).toString('base64url');
}

function sha256(text: string) {
    return crypto.createHash('sha256').update(text).digest();
}

function passwordMatches(users: any, username: string, password: string) {
    const known = Object.hasOwn(users, username) && typeof users[username] === 'string';
    const expected = known ? users[username] : '';
    const equal = crypto.timingSafeEqual(sha256(expected), sha256(password));
    return known && equal;
}

function loginPage(message = '') {
    // action="login" is relative, so it posts back to the same prefix
    // ("/v3/api/login" -> "/v3/api/login") whatever the proxy path is
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Meetup Station login</title>
</head>
<body>
    <form method="post" action="login">
        <p>${message}</p>
        <p><input type="text" name="username" placeholder="username"
            autocomplete="username" autofocus required></p>
        <p><input type="password" name="password" placeholder="password"
            autocomplete="current-password" required></p>
        <p><button type="submit">Log in</button></p>
    </form>
</body>
</html>
`;
}

async function getBody(
    request: http.IncomingMessage
): Promise<string> {
    const maxBodySize = 1024 * 1024;
    return new Promise((resolve, reject) => {
        const bodyParts: Buffer[] = [];
        let bodySize = 0;
        let aborted = false;

        request.on('data', (chunk: Buffer) => {
            if (aborted) return;

            bodySize += chunk.length;

            if (bodySize > maxBodySize) {
                aborted = true;
                request.destroy();
                reject(new Error('Request body too large'));
                return;
            }

            bodyParts.push(chunk);
        });

        request.on('end', () => {
            if (!aborted) {
                resolve(Buffer.concat(bodyParts).toString());
            }
        });

        request.on('error', (err) => {
            if (!aborted) {
                reject(err);
            }
        });
    });
}

function deleteOldHosts() {
    const entries = Object.entries(hosts);

    entries.sort(([, a], [, b]) => a.updated.getTime() - b.updated.getTime());

    const maxHostsCount = 1000;
    const maxAge = 120 * 1000;
    const now = new Date().getTime();

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const entryTime = entry[1].updated.getTime();
        if (index >= entries.length - maxHostsCount &&
            now - entryTime <= maxAge
        ) {
            break;
        }

        const hostId = entry[0];
        delete hosts[hostId];
    }

    const hostsCount = Object.keys(hosts).length;
    if (entries.length !== hostsCount) {
        console.log(`${new Date().toLocaleString()}: freed up hosts from ${entries.length} to ${hostsCount}`);
    }
}

function main() {
    const server = http.createServer(async (request, response) => {
        let urlStruct: URL | null = null;
        try {
            deleteOldHosts();

            const fullUrl = 'http://host' + decodeURI(request.url || '');
            urlStruct = URL.parse(fullUrl);
            if (urlStruct === null) {
                console.error(request);
                throw new Error(`when parsing the url: ${fullUrl}`);
            }
            const url = urlStruct.pathname.split('/').filter(item => !!item).at(-1) || '';

            if (url === 'host' && request.method === 'POST') {
                const body: string = await getBody(request);
                const bodyObject = JSON.parse(body);
                const description: string = bodyObject.description || '';
                const candidates: string[] = bodyObject.candidates || [];
                let id: string = bodyObject.id || '';
                const accessKey = bodyObject.accessKey || '';

                if (id === '') {
                    do {
                        id = `${crypto.randomBytes(4).toString('hex')} ${crypto.randomBytes(4).toString('hex')}`;
                    } while (hosts[id] !== undefined);
                }

                const newAccessKey = bodyObject.accessKey === undefined ?
                    '' :
                    (accessKey || `${crypto.randomBytes(8).toString('hex')}`);

                if (!hosts[id]) {
                    hosts[id] = {
                        hostDescription: description,
                        hostCandidates: candidates,
                        guestDescription: '',
                        guestCandidates: [],
                        hostAccessKey: newAccessKey,
                        guestAccessKey: '',
                        updated: new Date()
                    };
                } else if (hosts[id].hostAccessKey === accessKey) {
                    const host = hosts[id];
                    if (description) {
                        host.hostDescription = description;
                    }
                    for (const candidate of candidates) {
                        host.hostCandidates.push(candidate);
                    }

                    if (0 == description.length && 0 == candidates.length) {
                        host.guestCandidates = [];
                        host.guestDescription = '';
                        host.guestAccessKey = '';
                    }

                    host.updated = new Date();
                } else {
                    throw new Error(`when checking the host: host is already in a call: ${id}`);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    id: id,
                    accessKey: hosts[id].hostAccessKey
                }));

                console.log(`${new Date().toLocaleString()}: host id: ${id}`);
                console.log(`${new Date().toLocaleString()}: host sdp description: ${description}`);
                for (const candidate of candidates) {
                    console.log(`${new Date().toLocaleString()}: host ice candidate: ${candidate}`);
                }
            } else if (url === 'host' && request.method === 'GET') {
                const id: string = urlStruct.searchParams.get('id') || '';
                const accessKey = urlStruct.searchParams.get('accessKey') || '';

                const host = hosts[id];
                if (!host) {
                    throw new Error('when checking the host: empty or unkown host id');
                }
                if (host.guestDescription) {
                    throw new Error(`when checking the host: logic error: ${id}`);
                }
                if (host.guestAccessKey !== accessKey) {
                    throw new Error(`when checking the host: host is already in a call: ${id}`);
                }

                host.guestAccessKey = !urlStruct.searchParams.has('accessKey') ?
                    '' :
                    (accessKey || `${crypto.randomBytes(8).toString('hex')}`);

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    id: id,
                    description: host.hostDescription,
                    candidates: host.hostCandidates,
                    accessKey: host.guestAccessKey
                }));

                host.hostCandidates = [];
                host.hostDescription = '';

            } else if (url === 'guest' && request.method === 'POST') {
                const body: string = await getBody(request);
                const bodyObject = JSON.parse(body);

                const hostId: string = bodyObject.hostId || '';
                const description: string = bodyObject.description || '';
                const candidates: string[] = bodyObject.candidates || [];
                const accessKey = bodyObject.accessKey || '';

                if (hostId === '') {
                    throw new Error('when creating the guest: empty hostId');
                }

                const host = hosts[hostId];
                if (!host) {
                    throw new Error(`when creating the guest: host not found: ${hostId}`);
                }
                if (host.guestAccessKey !== accessKey) {
                    throw new Error(`when creating the guest: host is already in a call: ${hostId}`);
                }

                if (description) {
                    host.guestDescription = description;
                }
                for (const candidate of candidates) {
                    host.guestCandidates.push(candidate);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end('{}');

                console.log(`${new Date().toLocaleString()}: host id: ${hostId}`);
                console.log(`${new Date().toLocaleString()}: guest sdp description: ${description}`);
                for (const candidate of candidates) {
                    console.log(`${new Date().toLocaleString()}: guest ice candidate: ${candidate}`);
                }
            } else if (url === 'guest' && request.method === 'GET') {
                const hostId: string = urlStruct.searchParams.get('hostId') || '';
                const accessKey = urlStruct.searchParams.get('accessKey') || '';

                if (hostId === '') {
                    throw new Error('when checking for a guest: empty hostId');
                }

                const host = hosts[hostId];
                if (!host) {
                    throw new Error(`when checking for a guest: host not found: ${hostId}`);
                }
                if (host.hostAccessKey !== accessKey) {
                    throw new Error(`when checking for a guest: host is already in a call: ${hostId}`);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    description: host.guestDescription,
                    candidates: host.guestCandidates
                }));

                if (host.guestDescription) {
                    host.guestAccessKey = '';
                }
                host.guestCandidates = [];
                host.guestDescription = '';
            } else if (url === 'login' && request.method === 'GET') {
                response.statusCode = 200;
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end(loginPage());
            } else if (url === 'login' && request.method === 'POST') {
                const form = new URLSearchParams(await getBody(request));
                const username = form.get('username') ?? '';
                const password = form.get('password') ?? '';

                const users = JSON.parse(await fs.readFile(users_file, 'utf8'));

                const target = new URL(request.url || '/', 'http://host');
                const pathParts = target.pathname.split('/').filter(Boolean);

                pathParts.splice(-2, 2);

                target.pathname = '/' + pathParts.join('/');
                target.search = '';
                target.searchParams.set(
                    'storage',
                    encodedStorage(username, passwordMatches(users, username, password))
                );
            
                response.writeHead(303, {
                    Location: target.pathname + target.search,
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                    'Content-Length': 0
                });
                response.end();
            } else if (url === 'debug') {
                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end('{}');

                for (const entry of Object.entries(hosts)) {
                    console.log(`${new Date().toLocaleString()}: host id: ${entry[0]}`);
                    console.log(`${new Date().toLocaleString()}: host sdp description: ${entry[1].hostDescription}`);
                    for (const candidate of entry[1].hostCandidates) {
                        console.log(`${new Date().toLocaleString()}: host ice candidate:     ${candidate}`);
                    }
                    console.log(`${new Date().toLocaleString()}: guest sdp description: ${entry[1].guestDescription}`);
                    for (const candidate of entry[1].guestCandidates) {
                        console.log(`${new Date().toLocaleString()}: guest ice candidate:     ${candidate}`);
                    }
                    console.log(`${new Date().toLocaleString()}: host access key: ${entry[1].hostAccessKey}`);
                    console.log(`${new Date().toLocaleString()}: guest access key: ${entry[1].guestAccessKey}`);
                    console.log(`${new Date().toLocaleString()}: host updated at: ${entry[1].updated.toLocaleString()}`);
                }
            } else {
                throw new Error('unhandled endpoint');
            }
        } catch (error) {
            console.log(urlStruct);
            console.log(request.headers);
            console.log(request.url);
            console.log(request.method);

            // const body = await getBody(request);
            // console.log(body);

            response.statusCode = 404;
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({
                    error: 'that\'s an error'
            }));
            console.error(`${new Date().toLocaleString()}: ${error}`);
        }
    });

    server.listen(port, hostname, () => {
        console.log(`${new Date().toLocaleString()}: Server running at http://${hostname}:${port}/`);
    });
}

main();