'use strict';

const env = require('./env'),
    path = require('path'),
    BbPromise = require('bluebird'),
    Loki = require('lokijs'),
    fs = BbPromise.promisifyAll(require("fs-extra")),
    md5 = require('md5');

const CONTAINERS_COL_NAME = 'Containers';

class StorageManager {
    constructor() {
        this.dbName = '__azurite_db__.json'
    }

    init(localStoragePath) {
        this.dbPath = path.join(localStoragePath, this.dbName);
        this.db = BbPromise.promisifyAll(new Loki(this.dbPath));
        return fs.statAsync(this.dbPath)
            .then((stat) => {
                return this.db.loadDatabaseAsync(this.dbName);
            })
            .then((data) => {
                if (!this.db.getCollection(CONTAINERS_COL_NAME)) {
                    this.db.addCollection(CONTAINERS_COL_NAME);
                    return this.db.saveDatabaseAsync();
                }
            })
            .catch((e) => {
                if (e.code === 'ENOENT') {
                    // No DB hasn't been persisted / initialized yet.
                    this.db.addCollection(CONTAINERS_COL_NAME);
                    return this.db.saveDatabaseAsync();
                }
                // This should never happen!
                console.error(`Failed to initialize database at "${this.dbPath}"`);
                throw e;
            });
    }

    createContainer(model) {
        let p = path.join(env.localStoragePath, model.name);
        return fs.mkdirAsync(p)
            .then(() => {
                let tables = this.db.getCollection(CONTAINERS_COL_NAME);
                tables.insert({ name: model.name, http_props: model.httpProps, meta_props: model.metaProps, access: model.access });
                return this.db.saveDatabaseAsync();
            });
    }

    deleteContainer(name) {
        let container = path.join(env.localStoragePath, name);
        return fs.statAsync(container)
            .then((stat) => {
                return fs.removeAsync(container);
            })
            .then(() => {
                let tables = this.db.getCollection(CONTAINERS_COL_NAME);
                tables.chain().find({ 'name': { '$eq': name } }).remove();
                // TODO: Delete all blobs stored in the container
                return this.db.saveDatabaseAsync();
            });
    }

    listContainer(prefix, maxresults) {
        return BbPromise.try(() => {
            maxresults = parseInt(maxresults);
            let tables = this.db.getCollection(CONTAINERS_COL_NAME);
            let result = tables.chain()
                .find({ 'name': { '$contains': prefix } })
                .simplesort('name')
                .limit(maxresults)
                .data();
            return result;
        });
    }

    createBlockBlob(container, blobName, body, httpProps, metaProps, content) {
        let containerPath = path.join(env.localStoragePath, container);
        let blobPath = path.join(containerPath, blobName);
        let response = {};

        return fs.statAsync(containerPath)
            .then((stat) => {
                const sourceMD5 = httpProps['Content-MD5'];
                const targetMD5 = md5(body);
                response.md5 = targetMD5;
                if (sourceMD5) {
                    if (targetMD5 !== sourceMD5) {
                        const err = new Error('MD5 hash corrupted.');
                        err.name = 'md5';
                        throw err;
                    }
                }
            })
            .then(() => {
                // Container exists, otherwise fs.statAsync throws error
                return fs.outputFileAsync(blobPath, body, { encoding: httpProps['Content-Encoding'] });
            })
            .then(() => {
                let coll = this.db.getCollection(container);
                if (!coll) {
                    coll = this.db.addCollection(container);
                }
                const blobResult = coll.chain()
                    .find({ 'name': { '$eq': blobName } })
                    .data();

                if (blobResult.length === 0) {
                    const newBlob = coll.insert({
                        name: blobName,
                        http_props: httpProps,
                        meta_props: metaProps
                    });
                    response.ETag = newBlob.meta.revision;
                    response.lastModified = httpProps.lastModified;
                    return this.db.saveDatabaseAsync();
                } else {
                    const updateBlob = blobResult[0];
                    updateBlob.http_props = httpProps;
                    updateBlob.meta_props = metaProps;
                    coll.update(updateBlob);
                    response.ETag = updateBlob.meta.revision;
                    response.lastModified = httpProps.lastModified;
                    return this.db.saveDatabaseAsync();
                }
            })
            .then(() => {
                return response;
            });
    }
}

module.exports = new StorageManager;