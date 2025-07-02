import http from 'http';
import crypto from 'crypto';

const hostname = '127.0.0.1';
const port = 3000;
const hosts: {
    [id: string]: {
        description: string,
        guestDescription: string,
        created: Date
    }
} = {};
const hostsRev: {
    [description: string]: string
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
            const hostDescription = entry[1].description;
            delete hosts[hostId];
            delete hostsRev[hostDescription];
        }
    } else {
        const now = new Date().getTime();

        for (const entry of entries) {
            const entryTime = entry[1].created.getTime();

            if ((now - entryTime) / 1000 > 600) {
                const hostId = entry[0];
                const hostDescription = entry[1].description;
                delete hosts[hostId];
                delete hostsRev[hostDescription];
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
                const description: string = JSON.parse(body).description || '';
                let id: string = JSON.parse(body).id || (hostsRev[description] ? hostsRev[description] : '');

                if (description === '') {
                    throw new Error('when creating the host: empty description');
                }

                if (hosts[id]) {
                    delete hostsRev[hosts[id].description];
                    delete hosts[id];
                }
                if (hostsRev[description]) {
                    delete hosts[hostsRev[description]];
                    delete hostsRev[description];
                }

                if (id === '') {
                    do {
                        id = `${crypto.randomBytes(4).toString('hex')} ${crypto.randomBytes(4).toString('hex')}`;
                    } while (hosts[id] !== undefined);
                }

                hosts[id] = {
                    description: description,
                    guestDescription: '',
                    created: new Date()
                };
                hostsRev[description] = id;

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(`{"id": "${id}"}`);

                console.log(`${new Date().toLocaleString()}: host id: ${id}`);
                console.log(`${new Date().toLocaleString()}: host sdp description: ${description}`);
            } else if (url === 'host' && request.method === 'GET') {
                const id: string = urlStruct.searchParams.get('id') || '';
                const host = hosts[id];
                if (!host) {
                    throw new Error('when checking the host: empty or unkown host id');
                }
                if (host.guestDescription) {
                    throw new Error(`when checking the host: host is already in a call: ${id}`);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(`{"id": "${id}", "description": "${host.description}"}`);
            } else if (url === 'guest' && request.method === 'POST') {
                const body: string = await getBody(request);
                const hostId: string = JSON.parse(body).hostId || '';
                const guestDescription: string = JSON.parse(body).guestDescription || '';

                if (hostId === '') {
                    throw new Error('when creating the guest: empty hostId');
                }
                if (guestDescription === '') {
                    throw new Error('when creating the guest: empty guestDescription');
                }
                const host = hosts[hostId];
                if (!host) {
                    throw new Error(`when creating the guest: host not found: ${hostId}`);
                }

                host.guestDescription = guestDescription;

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end('{}');

                console.log(`${new Date().toLocaleString()}: host id: ${hostId}`);
                console.log(`${new Date().toLocaleString()}: host sdp description: ${host.description}`);
                console.log(`${new Date().toLocaleString()}: guest sdp description: ${host.guestDescription}`);
            } else if (url === 'guest' && request.method === 'GET') {
                const hostId: string = urlStruct.searchParams.get('hostId') || '';

                if (hostId === '') {
                    throw new Error('when checking for a guest: empty hostId');
                }

                const host = hosts[hostId];
                if (!host) {
                    throw new Error(`when checking for a guest: host not found: ${hostId}`);
                }

                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(`{"guestDescription": "${host.guestDescription}"}`);

                if (host.guestDescription) {
                    const description = host.description;

                    delete hosts[hostId];
                    delete hostsRev[description];
                }
            } else if (url === 'debug') {
                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/json');
                response.end('{}');

                for (const entry of Object.entries(hosts)) {
                    console.log(`${new Date().toLocaleString()}: host id: ${entry[0]}`);
                    console.log(`${new Date().toLocaleString()}: host sdp description: ${entry[1].description}`);
                    console.log(`${new Date().toLocaleString()}: guest sdp description: ${entry[1].guestDescription}`);
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
            response.end('{"error": "that\'s an error"}');
            console.error(`${new Date().toLocaleString()}: ${error}`);
        }
    });

    server.listen(port, hostname, () => {
        console.log(`${new Date().toLocaleString()}: Server running at http://${hostname}:${port}/`);
    });
}

main();