import http from 'http';
import crypto from 'crypto';

const hostname = '127.0.0.1';
const port = 3000;
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

    const now = new Date().getTime();

    for (const entry of entries) {
        const entryTime = entry[1].updated.getTime();

        if ((now - entryTime) / 1000 > 120) {
            const hostId = entry[0];
            delete hosts[hostId];
        } else {
            break;
        }
    }

    const maxHostsCount = 1000;

    if (entries.length > maxHostsCount) {
        const excess = entries.length - maxHostsCount;
        for (let index = 0; index < excess; index++) {
            const entry = entries[index];

            const hostId = entry[0];
            delete hosts[hostId];
        }
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