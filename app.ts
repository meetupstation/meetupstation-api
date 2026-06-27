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
        created: Date
    }
} = {};

async function getBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        const bodyParts: any[] = [];
        let body;
        request.on('data', (chunk) => {
            // console.log('data');
            bodyParts.push(chunk);
        }).on('end', () => {
            // console.log('end');
            body = Buffer.concat(bodyParts).toString();
            resolve(body);
        });
    });
}

function deleteOldHosts() {
    const entries = Object.entries(hosts);

    entries.sort(([, a], [, b]) => a.created.getTime() - b.created.getTime());

    const maxHostsCount = 1000;

    if (entries.length > maxHostsCount) {
        const excess = entries.length - maxHostsCount;
        for (let index = 0; index < excess; index++) {
            const entry = entries[index];

            const hostId = entry[0];
            delete hosts[hostId];
        }
    } else {
        const now = new Date().getTime();

        for (const entry of entries) {
            const entryTime = entry[1].created.getTime();

            if ((now - entryTime) / 1000 > 600) {
                const hostId = entry[0];
                delete hosts[hostId];
            } else {
                break;
            }
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
                const candidate: string = bodyObject.candidate || '';
                let id: string = bodyObject.id;
                const accessKey = bodyObject.accessKey || '';

                if (id === '') {
                    do {
                        id = `${crypto.randomBytes(4).toString('hex')} ${crypto.randomBytes(4).toString('hex')}`;
                    } while (hosts[id] !== undefined);
                } else if (hosts[id] && accessKey !== hosts[id].hostAccessKey) {
                    delete hosts[id];
                }

                const newAccessKey = bodyObject.accessKey === undefined ?
                    '' :
                    (accessKey || `${crypto.randomBytes(8).toString('hex')}`);

                if (!hosts[id]) {
                    hosts[id] = {
                        hostDescription: description,
                        hostCandidates: candidate ? [candidate] : [],
                        guestDescription: '',
                        guestCandidates: [],
                        hostAccessKey: newAccessKey,
                        guestAccessKey: '',
                        created: new Date()
                    };
                } else {
                    const host = hosts[id];
                    if (description) {
                        host.hostDescription = description;
                    }
                    if (candidate) {
                        host.hostCandidates.push(candidate);
                    }
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    id: id,
                    accessKey: hosts[id].hostAccessKey
                }));

                console.log(`${new Date().toLocaleString()}: host id: ${id}`);
                console.log(`${new Date().toLocaleString()}: host sdp description: ${description}`);
                console.log(`${new Date().toLocaleString()}: host ice candidate: ${candidate}`);
            } else if (url === 'host' && request.method === 'GET') {
                const id: string = urlStruct.searchParams.get('id') || '';
                const accessKeyInput = urlStruct.searchParams.get('accessKey');
                const accessKey = accessKeyInput || '';

                const host = hosts[id];
                if (!host) {
                    throw new Error('when checking the host: empty or unkown host id');
                }
                if (host.guestDescription || host.guestAccessKey !== accessKey) {
                    throw new Error(`when checking the host: host is already in a call: ${id}`);
                }

                host.guestAccessKey = accessKeyInput === undefined ?
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

            } else if (url === 'guest' && request.method === 'POST') {
                const body: string = await getBody(request);
                const bodyObject = JSON.parse(body);

                const hostId: string = bodyObject.hostId || '';
                const description: string = bodyObject.description || bodyObject.guestDescription || '';
                const candidate: string = bodyObject.candidate || '';
                const accessKey = bodyObject.accessKey || '';

                if (hostId === '') {
                    throw new Error('when creating the guest: empty hostId');
                }

                const host = hosts[hostId];
                if (!host || host.guestAccessKey !== accessKey) {
                    throw new Error(`when creating the guest: host not found: ${hostId}`);
                }

                if (description) {
                    host.guestDescription = description;
                }
                if (candidate) {
                    host.guestCandidates.push(candidate);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end('{}');

                console.log(`${new Date().toLocaleString()}: host id: ${hostId}`);
                console.log(`${new Date().toLocaleString()}: guest sdp description: ${description}`);
                console.log(`${new Date().toLocaleString()}: ice candidate: ${candidate}`);
            } else if (url === 'guest' && request.method === 'GET') {
                const hostId: string = urlStruct.searchParams.get('hostId') || '';
                const accessKey = urlStruct.searchParams.get('accessKey') || '';

                if (hostId === '') {
                    throw new Error('when checking for a guest: empty hostId');
                }

                const host = hosts[hostId];
                if (!host || host.hostAccessKey !== accessKey) {
                    throw new Error(`when checking for a guest: host not found: ${hostId}`);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({
                    guestDescription: host.guestDescription,
                    description: host.guestDescription,
                    candidates: host.guestCandidates
                }));

                host.guestCandidates = [];
                if (host.guestDescription) {
                    delete hosts[hostId];
                }
            } else if (url === 'debug') {
                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end('{}');

                for (const entry of Object.entries(hosts)) {
                    console.log(`${new Date().toLocaleString()}: host id: ${entry[0]}`);
                    console.log(`${new Date().toLocaleString()}: host sdp description: ${entry[1].hostDescription}`);
                    for (const candidate of entry[1].hostCandidates) {
                        console.log(`${new Date().toLocaleString()}: host candidate:     ${candidate}`);
                    }
                    console.log(`${new Date().toLocaleString()}: guest sdp description: ${entry[1].guestDescription}`);
                    for (const candidate of entry[1].guestCandidates) {
                        console.log(`${new Date().toLocaleString()}: guest candidate:     ${candidate}`);
                    }
                    console.log(`${new Date().toLocaleString()}: host access key: ${entry[1].hostAccessKey}`);
                    console.log(`${new Date().toLocaleString()}: guest access key: ${entry[1].guestAccessKey}`);
                    console.log(`${new Date().toLocaleString()}: host created at: ${entry[1].created.toLocaleString()}`);
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