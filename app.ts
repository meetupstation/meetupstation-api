import http from 'http';
import crypto from 'crypto';
import fs from 'fs/promises';

const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 3000;
const users_file = process.env.USERS_FILE || './users.json';

const rooms: {
    [id: string]: {
        hostDescription: string,
        hostCandidates: string[],
        guestDescription: string,
        guestCandidates: string[],
        hostAccessKey: string,
        guestAccessKey: string,
        updated: Date
    }
} = Object.create(null);

async function encodedStorage(
    users: {
        [name: string]: {
            password: string,
            iceServers: {
                turnSecret: string,
                duration: number,
                urls: string[]
            }[],
            iceTransportPolicy: string
        }
    },
    username: string,
    password: string): Promise<string> {
    await new Promise(resolve => setTimeout(resolve, 200));

    const iceServers: {
        urls: string[],
        username: string,
        credential: string
    }[] = [];
    let iceTransportPolicy = 'all';

    if (Object.hasOwn(users, username) &&
        typeof users[username] === 'object' &&
        users[username] !== null &&
        typeof users[username].password === 'string' &&
        Array.isArray(users[username].iceServers) &&
        users[username].password !== '' &&
        users[username].password === password &&
        typeof users[username].iceTransportPolicy === 'string' &&
        users[username].iceTransportPolicy !== '') {

        iceTransportPolicy = users[username].iceTransportPolicy;

        for (const iceServer of users[username].iceServers) {
            if (typeof iceServer.turnSecret === 'string' &&
                iceServer.turnSecret !== '' &&
                typeof iceServer.duration === 'number' &&
                Number.isSafeInteger(iceServer.duration) &&
                iceServer.duration > 0) {
                let urlsAreCorrect = Array.isArray(iceServer.urls) && iceServer.urls.length > 0;
                if (urlsAreCorrect) {
                    for (const url of iceServer.urls) {
                        if (typeof url !== 'string' ||
                            url === '') {
                            urlsAreCorrect = false;
                            break;
                        }
                    }
                }
                if (urlsAreCorrect) {
                    const expiry = Math.floor(Date.now() / 1000) + iceServer.duration;
                    const iceusername = `${expiry}:${username}`;
                    const credential = crypto
                        .createHmac('sha1', iceServer.turnSecret)
                        .update(iceusername)
                        .digest('base64');

                    iceServers.push({
                        urls: iceServer.urls,
                        username: iceusername,
                        credential: credential
                    });
                }
            }
        }
    }

    const storage = {
        rooms: [],
        rtcConfiguration: {
            iceServers: iceServers,
            iceTransportPolicy: iceTransportPolicy
        },
        signalServer: ''
    };
    return Buffer.from(JSON.stringify(storage)).toString('base64url');
}

function loginPage(message = '') {
    // action="login" is relative, so it posts back to the same prefix
    // ("/v3/api/login" -> "/v3/api/login") whatever the proxy path is
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Meetup Station Login</title>
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

function deleteOldRooms() {
    const entries = Object.entries(rooms);

    entries.sort(([, a], [, b]) => a.updated.getTime() - b.updated.getTime());

    const maxRoomsCount = 1000;
    const maxAge = 120 * 1000;
    const now = new Date().getTime();

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const entryTime = entry[1].updated.getTime();
        if (index >= entries.length - maxRoomsCount &&
            now - entryTime <= maxAge
        ) {
            break;
        }

        const hostId = entry[0];
        delete rooms[hostId];
    }

    const roomsCount = Object.keys(rooms).length;
    if (entries.length !== roomsCount) {
        console.log(`${new Date().toLocaleString()}: freed up rooms from ${entries.length} to ${roomsCount}`);
    }
}

function main() {
    const server = http.createServer(async (request, response) => {
        let urlStruct: URL | null = null;
        try {
            deleteOldRooms();

            const fullUrl = 'http://host' + decodeURI(request.url || '');
            urlStruct = URL.parse(fullUrl);
            if (urlStruct === null) {
                console.error(request);
                throw new Error(`when parsing the url: ${fullUrl}`);
            }
            const url = urlStruct.pathname.split('/').filter(item => !!item).at(-1) || '';

            if (url === 'host' && request.method === 'POST') {
                const body: string = await getBody(request);
                const bodyObjectTemp = JSON.parse(body);
                if (bodyObjectTemp &&
                    bodyObjectTemp.candidates === undefined) {
                    bodyObjectTemp.candidates = [];
                }
                const bodyObject: {
                    id: string,
                    description: string,
                    candidates: string[],
                    accessKey: string|undefined
                } = bodyObjectTemp;

                if (typeof bodyObject !== 'object' ||
                    bodyObject === null ||
                    typeof bodyObject.id !== 'string' ||
                    typeof bodyObject.description !== 'string' ||
                    Array.isArray(bodyObject.candidates) === false ||
                    (
                        typeof bodyObject.accessKey !== 'string' &&
                        bodyObject.accessKey !== undefined
                    )
                ) {
                    throw new Error('malformed input');
                }

                const description: string = bodyObject.description;
                const candidates: string[] = (() => {
                    const candidates = [];
                    for (const candidate of bodyObject.candidates) {
                        if (typeof candidate === 'string' &&
                            candidate
                        ) {
                            candidates.push(candidate);
                        }
                    }
                    return candidates;
                })();
                let id: string = bodyObject.id;
                const accessKey = bodyObject.accessKey || '';

                if (id === '') {
                    do {
                        id = `${crypto.randomBytes(4).toString('hex')} ${crypto.randomBytes(4).toString('hex')}`;
                    } while (rooms[id] !== undefined);
                }

                const newAccessKey = bodyObject.accessKey === undefined ?
                    '' :
                    (accessKey || `${crypto.randomBytes(8).toString('hex')}`);

                if (!rooms[id]) {
                    rooms[id] = {
                        hostDescription: description,
                        hostCandidates: candidates,
                        guestDescription: '',
                        guestCandidates: [],
                        hostAccessKey: newAccessKey,
                        guestAccessKey: '',
                        updated: new Date()
                    };
                } else if (rooms[id].hostAccessKey === accessKey) {
                    const room = rooms[id];
                    if (description) {
                        room.hostDescription = description;
                    }
                    for (const candidate of candidates) {
                        room.hostCandidates.push(candidate);
                    }

                    if (0 == description.length && 0 == candidates.length) {
                        room.guestCandidates = [];
                        room.guestDescription = '';
                        room.guestAccessKey = '';
                    }

                    room.updated = new Date();
                } else {
                    throw new Error(`when posting the host: room is already being negotiated at the moment: ${id}`);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    id: id,
                    accessKey: rooms[id].hostAccessKey
                }));

                console.log(`${new Date().toLocaleString()}: room id: ${id}`);
                console.log(`${new Date().toLocaleString()}: host sdp description: ${description}`);
                for (const candidate of candidates) {
                    console.log(`${new Date().toLocaleString()}: host ice candidate: ${candidate}`);
                }
            } else if (url === 'host' && request.method === 'GET') {
                const id: string = urlStruct.searchParams.get('id') || '';
                const accessKey = urlStruct.searchParams.get('accessKey') || '';

                const room = rooms[id];
                if (!room) {
                    throw new Error('when getting the host: empty or unkown room id');
                }
                if (room.guestDescription) {
                    throw new Error(`when getting the host: logic error: ${id}`);
                }
                if (room.guestAccessKey !== accessKey) {
                    throw new Error(`when getting the host: room is already being negotiated at the moment: ${id}`);
                }

                room.guestAccessKey = !urlStruct.searchParams.has('accessKey') ?
                    '' :
                    (accessKey || `${crypto.randomBytes(8).toString('hex')}`);

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    id: id,
                    description: room.hostDescription,
                    candidates: room.hostCandidates,
                    accessKey: room.guestAccessKey
                }));

                room.hostCandidates = [];
                room.hostDescription = '';
            } else if (url === 'guest' && request.method === 'POST') {
                const body: string = await getBody(request);
                const bodyObjectTemp = JSON.parse(body);
                if (bodyObjectTemp &&
                    bodyObjectTemp.hostId &&
                    !bodyObjectTemp.id) {
                    bodyObjectTemp.id = bodyObjectTemp.hostId;
                }
                if (bodyObjectTemp &&
                    bodyObjectTemp.candidates === undefined) {
                    bodyObjectTemp.candidates = [];
                }
                const bodyObject: {
                    id: string,
                    description: string,
                    candidates: string[],
                    accessKey: string|undefined
                } = bodyObjectTemp;

                if (typeof bodyObject !== 'object' ||
                    bodyObject === null ||
                    typeof bodyObject.id !== 'string' ||
                    typeof bodyObject.description !== 'string' ||
                    Array.isArray(bodyObject.candidates) === false ||
                    (
                        typeof bodyObject.accessKey !== 'string' &&
                        bodyObject.accessKey !== undefined
                    )
                ) {
                    throw new Error('malformed input');
                }

                const id: string = bodyObject.id;
                const description: string = bodyObject.description;
                const candidates: string[] = (() => {
                    const candidates = [];
                    for (const candidate of bodyObject.candidates) {
                        if (typeof candidate === 'string' &&
                            candidate
                        ) {
                            candidates.push(candidate);
                        }
                    }
                    return candidates;
                })();
                const accessKey = bodyObject.accessKey || '';

                if (id === '') {
                    throw new Error('when posting the guest: empty room id');
                }

                const room = rooms[id];
                if (!room) {
                    throw new Error(`when posting the guest: room not found: ${id}`);
                }
                if (room.guestAccessKey !== accessKey) {
                    throw new Error(`when creating the guest: room is already being negotiated at the moment: ${id}`);
                }

                if (description) {
                    room.guestDescription = description;
                }
                for (const candidate of candidates) {
                    room.guestCandidates.push(candidate);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end('{}');

                console.log(`${new Date().toLocaleString()}: room id: ${id}`);
                console.log(`${new Date().toLocaleString()}: guest sdp description: ${description}`);
                for (const candidate of candidates) {
                    console.log(`${new Date().toLocaleString()}: guest ice candidate: ${candidate}`);
                }
            } else if (url === 'guest' && request.method === 'GET') {
                const hostId: string = urlStruct.searchParams.get('hostId') || '';
                const id: string = urlStruct.searchParams.get('id') || hostId;
                const accessKey = urlStruct.searchParams.get('accessKey') || '';

                if (id === '') {
                    throw new Error('when getting the guest: empty room id');
                }

                const room = rooms[id];
                if (!room) {
                    throw new Error(`when getting the guest: room not found: ${id}`);
                }
                if (room.hostAccessKey !== accessKey) {
                    throw new Error(`when getting the guest: room is already being negotiated at the moment: ${id}`);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    description: room.guestDescription,
                    candidates: room.guestCandidates
                }));

                room.guestCandidates = [];
                room.guestDescription = '';
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
                    await encodedStorage(users, username, password)
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

                for (const entry of Object.entries(rooms)) {
                    console.log(`${new Date().toLocaleString()}: room id: ${entry[0]}`);
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
                    console.log(`${new Date().toLocaleString()}: room updated at: ${entry[1].updated.toLocaleString()}`);
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
