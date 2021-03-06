/**
 * Cryptonote Node.JS Pool
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Pool TCP daemon
 **/

// Load required modules
var fs = require('fs');
var net = require('net');
var tls = require('tls');
var async = require('async');
var bignum = require('bignum');
var crypto = require('crypto');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet, config.api);
var utils = require('./utils.js');

var cuHashing = require('cuckarood29v-hashing');

// Set nonce pattern - must exactly be 8 hex chars
var noncePattern = new RegExp("^[0-9A-Fa-f]{8}$");

// Set redis database cleanup interval
var cleanupInterval = config.redis.cleanupInterval && config.redis.cleanupInterval > 0 ? config.redis.cleanupInterval : 15;

// Initialize log system
var logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

var threadId = '(Thread ' + process.env.forkId + ') ';
var log = function(severity, system, text, data){
    global.log(severity, system, threadId + text, data);
};

// Set instance id
var instanceId = crypto.randomBytes(4);

// Pool variables
var poolStarted = false;
var connectedMiners = {};

var banningEnabled = config.poolServer.banning && config.poolServer.banning.enabled;
var bannedIPs = {};
var perIPStats = {};

// Block templates
var validBlockTemplates = [];
var currentBlockTemplate;

// Difficulty buffer
var diff1 = bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);

/**
 * Convert buffer to byte array
 **/
Buffer.prototype.toByteArray = function () {
    return Array.prototype.slice.call(this, 0);
};
net.Socket.prototype.minerId = 'dummy';

/**
 * Periodical updaters
 **/

// Every 30 seconds clear out timed-out miners and old bans
setInterval(function(){
    var now = Date.now();
    var timeout = config.poolServer.minerTimeout * 1000;
    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if (now - miner.lastBeat > timeout){
            log('warn', logSystem, 'Miner timed out and disconnected %s@%s', [miner.login, miner.ip]);
            delete connectedMiners[minerId];
        }
    }

    if (banningEnabled){
        for (ip in bannedIPs){
            var banTime = bannedIPs[ip];
            if (now - banTime > config.poolServer.banning.time * 1000) {
                delete bannedIPs[ip];
                delete perIPStats[ip];
                log('info', logSystem, 'Ban dropped for %s', [ip]);
            }
        }
    }

}, 30000);

/**
 * Handle multi-thread messages
 **/
process.on('message', function(message) {
    switch (message.type) {
        case 'banIP':
            bannedIPs[message.ip] = Date.now();
            break;
    }
});

/**
 * Block template
 **/
function BlockTemplate(template){
    this.blob = template.blocktemplate_blob;
    this.difficulty = template.difficulty;
    this.height = template.height;
    this.reserveOffset = template.reserved_offset;
    this.buffer = Buffer.from(this.blob, 'hex');
    instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3);
    this.previous_hash = Buffer.alloc(32);
    this.buffer.copy(this.previous_hash, 0, 7, 39);
    this.extraNonce = 0;

    // The clientNonceLocation is the location at which the client pools should set the nonces for each of their clients.
    this.clientNonceLocation = this.reserveOffset + 12;
    // The clientPoolLocation is for multi-thread/multi-server pools to handle the nonce for each of their tiers.
    this.clientPoolLocation = this.reserveOffset + 8;
}
BlockTemplate.prototype = {

    nextBlob: function(){
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
        return utils.cnUtil.convert_blob(this.buffer, 8).toString('hex');
    },
    nextBlobWithChildNonce: function(){
        // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
        this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
        // Don't convert the blob to something hashable.  You bad.
        return this.buffer.toString('hex');
    }
};

/**
 * Get block template
 **/
function getBlockTemplate(callback){
    apiInterfaces.rpcDaemon('getblocktemplate',
                            {reserve_size: 17, wallet_address: config.poolServer.poolAddress},
                            callback)
}

/**
 * Process block template
 **/
function processBlockTemplate(template){
    if (currentBlockTemplate)
        validBlockTemplates.push(currentBlockTemplate);

    if (validBlockTemplates.length > 3)
        validBlockTemplates.shift();

    currentBlockTemplate = new BlockTemplate(template);


    for (var minerId in connectedMiners){
        var miner = connectedMiners[minerId];
        if(!miner.noRetarget) {
            miner.retarget();
        }
        miner.pushMessage('getjobtemplate', miner.getJob(), minerId);
    }
}

/**
 * Job refresh
 **/

function jobRefresh(loop, callback){
    callback = callback || function(){};
    getBlockTemplate(function(error, result){
        if (loop)
            setTimeout(function(){
                jobRefresh(true);
            }, config.poolServer.blockRefreshInterval);
        if (error){
            log('error', logSystem, 'Error polling getblocktemplate %j', [error]);
            if (!poolStarted) log('error', logSystem, 'Could not start pool');
            callback(false);
            return;
        }

        let buffer = Buffer.from(result.blocktemplate_blob, 'hex');
        let new_hash = Buffer.alloc(32);
        buffer.copy(new_hash, 0, 7, 39);

        if (!currentBlockTemplate || result.height > currentBlockTemplate.height) {
            for (var minerId in connectedMiners){
                var miner = connectedMiners[minerId];
                miner.validJobs = [];
            }
            log('info', logSystem, 'New block to mine at height %d w/ difficulty of %d (bc to %d miners)', [result.height, result.difficulty, Object.keys(connectedMiners).length]);
            processBlockTemplate(result);
        }
        if (!poolStarted) {
            startPoolServerTcp(function(successful){ poolStarted = true });
        }
        callback(true);
    })
}

/**
 * Variable difficulty
 **/
var VarDiff = (function(){
    var variance = config.poolServer.varDiff.variancePercent / 100 * config.poolServer.varDiff.targetTime;
    return {
        variance: variance,
        bufferSize: config.poolServer.varDiff.retargetTime / config.poolServer.varDiff.targetTime * 4,
        tMin: config.poolServer.varDiff.targetTime - variance,
        tMax: config.poolServer.varDiff.targetTime + variance,
        maxJump: config.poolServer.varDiff.maxJump
    };
})();

/**
 * Miner
 **/
function Miner(id, login, pass, ip, port, agent, workerName, startingDiff, noRetarget, pushMessage){
    this.id = id;
    this.login = login;
    this.pass = pass;
    this.ip = ip;
    this.port = port;
    this.workerName = workerName;
    this.pushMessage = pushMessage;
    this.heartbeat();
    this.noRetarget = noRetarget;
    this.difficulty = startingDiff;
    this.validJobs = [];

    // Vardiff related variables
    this.shareTimeRing = utils.ringBuffer(16);
    this.lastShareTime = Date.now() / 1000 | 0;
}
Miner.prototype = {
    retarget: function(){

	    var now = Date.now() / 1000 | 0;
        var options = config.poolServer.varDiff;

        var sinceLast = now - this.lastShareTime;
        var decreaser = sinceLast > VarDiff.tMax;

        var avg = this.shareTimeRing.avg(decreaser ? sinceLast : null);
        var newDiff;

        var direction;

        if (avg > VarDiff.tMax && this.difficulty > options.minDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff > options.minDiff ? newDiff : options.minDiff;
            direction = -1;
        }
        else if (avg < VarDiff.tMin && this.difficulty < options.maxDiff){
            newDiff = options.targetTime / avg * this.difficulty;
            newDiff = newDiff < options.maxDiff ? newDiff : options.maxDiff;
            direction = 1;
        }
        else{
            return;
        }


        if (Math.abs(newDiff - this.difficulty) / this.difficulty * 100 > options.maxJump){
            var change = options.maxJump / 100 * this.difficulty * direction;
            newDiff = this.difficulty + change;
        }

        this.shareTimeRing.clear();
        if (decreaser) this.lastShareTime = now;
        newDiff = Math.round(newDiff);
        if(newDiff > currentBlockTemplate.difficulty) {
            newDiff=currentBlockTemplate.difficulty;
        }
        if (this.difficulty === newDiff) return;
        this.pendingDifficulty = newDiff;
        this.pushMessage('message', 'Retargetting difficulty '+this.difficulty+' to '+newDiff,this.id);
        log('info', logSystem, 'Retargetting difficulty %d to %d for %s', [this.difficulty, newDiff, this.login]);
    },
    heartbeat: function(){
        this.lastBeat = Date.now();
    },
    getTargetHex: function(){
        if (this.pendingDifficulty){
            this.lastDifficulty = this.difficulty;
            this.difficulty = this.pendingDifficulty;
            this.pendingDifficulty = null;
        }

        var padded = Buffer.alloc(32);
        padded.fill(0);

        var diffBuff = diff1.div(this.difficulty).toBuffer();
        diffBuff.copy(padded, 32 - diffBuff.length);

        var buff = padded.slice(0, 4);
        var buffArray = buff.toByteArray().reverse();
        var buffReversed = Buffer.from(buffArray);
        this.target = buffReversed.readUInt32BE(0);
        var hex = buffReversed.toString('hex');
        return hex;
    },
    getTargetDiff: function(){
        if (this.pendingDifficulty){
            this.lastDifficulty = this.difficulty;
            this.difficulty = this.pendingDifficulty;
            this.pendingDifficulty = null;
        }

        return this.difficulty;
    },
    getJob: function(){
        if (this.lastBlockHeight === currentBlockTemplate.height && !this.pendingDifficulty && this.cachedJob !== null) {
            return this.cachedJob;
        }
		var blob = currentBlockTemplate.nextBlob();
		this.lastBlockHeight = currentBlockTemplate.height;
		var difftarget = this.getTargetDiff();

		var newJob = {
			id: utils.uid(),
			extraNonce: currentBlockTemplate.extraNonce,
			height: currentBlockTemplate.height,
			difficulty: this.difficulty,
			diffHex: this.diffHex,
			submissions: []
		};

		this.validJobs.push(newJob);

		if (this.validJobs.length > 4)
			this.validJobs.shift();

		this.cachedJob = {
			pre_pow: blob,
			height: newJob.height,
			algo: "cuckarood",
			edgebits: 29,
			proofsize: 32,
			noncebytes: 4,
			job_id: newJob.id,
			difficulty: difftarget,
			id: this.id
		};
		return this.cachedJob;
    },
    checkBan: function(validShare){
        if (!banningEnabled) return;

        // Init global per-ip shares stats
        if (!perIPStats[this.ip]){
            perIPStats[this.ip] = { validShares: 0, invalidShares: 0 };
        }

        var stats = perIPStats[this.ip];
        validShare ? stats.validShares++ : stats.invalidShares++;

        if (stats.validShares + stats.invalidShares >= config.poolServer.banning.checkThreshold){
            if (stats.invalidShares / stats.validShares >= config.poolServer.banning.invalidPercent / 100){
                validShare ? this.validShares++ : this.invalidShares++;
                log('warn', logSystem, 'Banned %s@%s', [this.login, this.ip]);
                bannedIPs[this.ip] = Date.now();
                delete connectedMiners[this.id];
                process.send({type: 'banIP', ip: this.ip});
            }
            else{
                stats.invalidShares = 0;
                stats.validShares = 0;
            }
        }
    }
};

/**
 * Handle miner method
 **/
function handleMinerMethod(method, params, ip, portData, sendReply, pushMessage, setMinerid){
    var miner = connectedMiners[params.id];

    // Check for ban here, so preconnected attackers can't continue to screw you
    if (IsBannedIp(ip)){
        sendReply('Your IP is banned');
        return;
    }

    switch(method){
        case 'login':
            var login = params.login;
            if (!login){
                if (params.agent && params.agent.includes('Swap')) {
                    sendReply({code: -32600, message: "Missing login"}, null, 'submit');
                }
                else{
                    sendReply('Missing login');
                }
                return;
            }

            var port = portData.port;

            var pass = params.pass;
            var workerName = '';
            if (params.rigid) {
                workerName = params.rigid.trim();
            }
            else if (pass) {
                workerName = pass.trim();
                if (pass.indexOf(':') >= 0 && pass.indexOf('@') >= 0) {
                    passDelimiterPos = pass.lastIndexOf(':');
                    workerName = pass.substr(0, passDelimiterPos).trim();
                }
                workerName = workerName.replace(/:/g, '');
                workerName = workerName.replace(/\+/g, '');
                workerName = workerName.replace(/\s/g, '');
            }
            if (!workerName || workerName === '') {
                workerName = 'undefined';
            }
            workerName = utils.cleanupSpecialChars(workerName);

            var difficulty = portData.difficulty;
            var noRetarget = false;
            if(config.poolServer.fixedDiff.enabled) {
                var fixedDiffCharPos = login.lastIndexOf(config.poolServer.fixedDiff.addressSeparator);
                if (fixedDiffCharPos !== -1 && (login.length - fixedDiffCharPos < 32)){
                    diffValue = login.substr(fixedDiffCharPos + 1);
                    difficulty = parseInt(diffValue);
                    login = login.substr(0, fixedDiffCharPos);
                    if (!difficulty || difficulty != diffValue) {
                        log('warn', logSystem, 'Invalid difficulty value "%s" for login: %s', [diffValue, login]);
                        difficulty = portData.difficulty;
                    } else {
                        noRetarget = true;
                        if (difficulty < config.poolServer.varDiff.minDiff) {
                            difficulty = config.poolServer.varDiff.minDiff;
                        }
                    }
                }
            }

            var address = login;

            if (!address) {
                log('warn', logSystem, 'No address specified for login');
                if (params.agent && params.agent.includes('Swap')) {
                    sendReply({code: -32600, message: "Invalid address used for login"}, null, 'submit');
                }
                else{
                    sendReply('Invalid address used for login');
                }
            }

            if (!utils.validateMinerAddress(address)) {
                var addressPrefix = utils.getAddressPrefix(address);
                if (!addressPrefix) addressPrefix = 'N/A';

                log('warn', logSystem, 'Invalid address used for login (prefix: %s): %s', [addressPrefix, address]);
                if (params.agent && params.agent.includes('Swap')) {
                    sendReply({code: -32600, message: "Invalid address used for login"}, null, 'submit');
                }
                else{
                    sendReply('Invalid address used for login');
                }
                return;
            }

		    log('info', logSystem, 'LOGIN '+params.login+' : '+params.pass+' : '+params.agent);

            var minerId = utils.uid();
            miner = new Miner(minerId, login, pass, ip, port, params.agent, Buffer.from(workerName).toString('base64'), difficulty, noRetarget, pushMessage);
            connectedMiners[minerId] = miner;
            setMinerid(minerId);

			miner.pushMessage('login', 'ok',minerId);
			var job = miner.getJob();
			sendReply(null, {
				id: minerId,
				pre_pow:job.pre_pow,
				height: job.height,
				algo: "cuckarood",
				edgebits: 29,
				proofsize: 32,
				noncebytes: 4,
				job_id:job.job_id,
				difficulty: job.difficulty,
				status: 'OK'
			},'getjobtemplate');
        
            miner.pushMessage('message', 'Login OK (retarget:'+(noRetarget?'no':'yes')+')',minerId);

            break;
        case 'getjob':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, miner.getJob());
            break;
        case 'submit':
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();

            var job = miner.validJobs.filter(function(job){
                return job.id === params.job_id.toString();
            })[0];

            if (!job){
                var dateNow = Date.now();
				var dateNowSeconds = Date.now() / 1000 | 0;
                redisClient.zadd(config.coin + ':workerHashrate', dateNowSeconds, [miner.difficulty, miner.login+':'+miner.workerName, dateNow,3].join(':'));
				log('info', logSystem, 'Invalid job id '+miner.login+':'+miner.workerName);
                sendReply(null, 'stale', 'submit');
                return;
            }

            if (!params.nonce) {
                sendReply('Attack detected');
                var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
                log('warn', logSystem, 'Malformed miner share: ' + JSON.stringify(params) + ' from ' + minerText);
                return;
            }

            params.nonce = params.nonce.toString().toLowerCase();

            var cycle = params.pow.join(':');
            if (job.submissions.indexOf(cycle) !== -1){
                var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
                log('info', logSystem, 'Duplicate share: ' + JSON.stringify(params) + ' from ' + minerText);
                perIPStats[miner.ip] = { validShares: 0, invalidShares: 999999 };
                miner.checkBan(false);
                sendReply({code: -32505, message: "Duplicate share"}, null, 'submit');
                return;
            }

            job.submissions.push(cycle);

            var blockTemplate = currentBlockTemplate.height === job.height ? currentBlockTemplate : validBlockTemplates.filter(function(t){
                return t.height === job.height;
            })[0];

            if (!blockTemplate){
                sendReply({code: -32600, message: "pool error"}, null, 'submit');
                return;
            }

            var shareAccepted = processShare(miner, job, blockTemplate, params);
            miner.checkBan(shareAccepted);

            if (!shareAccepted){
                sendReply({code: -32502, message: "wrong hash"}, null, 'submit');
                return;
            }

            var now = Date.now() / 1000 | 0;
            miner.shareTimeRing.append(now - miner.lastShareTime);
            miner.lastShareTime = now;
            //miner.retarget(now);

            sendReply(null, 'ok', 'submit');
            break;
        case 'keepalived' :
            if (!miner){
                sendReply('Unauthenticated');
                return;
            }
            miner.heartbeat();
            sendReply(null, { status:'KEEPALIVED' });
            break;
        default:
            sendReply('Invalid method');
            var minerText = miner ? (' ' + miner.login + '@' + miner.ip) : '';
            log('warn', logSystem, 'Invalid method: %s (%j) from %s', [method, params, minerText]);
            break;
    }
}

/**
 * Return if IP has been banned
 **/
function IsBannedIp(ip){
    if (!banningEnabled || !bannedIPs[ip]) return false;

    var bannedTime = bannedIPs[ip];
    var bannedTimeAgo = Date.now() - bannedTime;
    var timeLeft = config.poolServer.banning.time * 1000 - bannedTimeAgo;
    if (timeLeft > 0){
        return true;
    }
    else {
        delete bannedIPs[ip];
        log('info', logSystem, 'Ban dropped for %s', [ip]);
        return false;
    }
}

function recordShareData(miner, job, shareDiff, blockCandidate, hashHex, shareType, blockTemplate){

    var dateNow = Date.now();
    var dateNowSeconds = dateNow / 1000 | 0;

    var redisCommands = [
        ['hincrby', config.coin + ':shares:roundCurrent', miner.login, job.difficulty],
        ['zadd', config.coin + ':workerHashrate', dateNowSeconds, [job.difficulty, miner.login+':'+miner.workerName, dateNow,0].join(':')],
        ['zadd', config.coin + ':hashrate', dateNowSeconds, [job.difficulty, miner.login, dateNow].join(':')],
        ['hincrby', config.coin + ':workers:' + miner.login, 'hashes', job.difficulty],
        ['hset', config.coin + ':workers:' + miner.login, 'lastShare', dateNowSeconds]
    ];

    if (blockCandidate){
        redisCommands.push(['hset', config.coin + ':stats', 'lastBlockFound', Date.now()]);
        redisCommands.push(['rename', config.coin + ':shares:roundCurrent', config.coin + ':shares:round' + job.height]);
        redisCommands.push(['hgetall', config.coin + ':shares:round' + job.height]);
    }

    redisClient.multi(redisCommands).exec(function(err, replies){
        if (err){
            log('error', logSystem, 'Failed to insert share data into redis %j \n %j', [err, redisCommands]);
            return;
        }
        if (blockCandidate){
            var workerShares = replies[replies.length - 1];
            var totalShares = Object.keys(workerShares).reduce(function(p, c){
                return p + parseInt(workerShares[c]);
            }, 0);
            redisClient.zadd(config.coin + ':blocks:candidates', job.height, [
                hashHex,
                Date.now() / 1000 | 0,
                blockTemplate.difficulty,
                totalShares,
				null,null,0
            ].join(':'), function(err, result){
                if (err){
                    log('error', logSystem, 'Failed inserting block candidate %s \n %j', [hashHex, err]);
                }
            });
        }

    });

    log('info', logSystem, 'Accepted %s share at difficulty %d/%d from %s@%s', [shareType, job.difficulty, shareDiff, miner.login, miner.ip]);

}

/**
 * Process miner share data
 **/
function processShare(miner, job, blockTemplate, params){
    var nonce = params.nonce;
    var resultHash = params.result;
    var template = Buffer.alloc(blockTemplate.buffer.length);
    blockTemplate.buffer.copy(template);
    template.writeUInt32BE(job.extraNonce, blockTemplate.reserveOffset);
    var shareBuffer;
    var shareType;
    var hashDiff=0;


	if(!params.pow || params.pow.length != 32)
		return;

    var jobdiff = cuHashing.getdifficultyfromhash(cuHashing.cycle_hash(params.pow));

    shareBuffer = utils.cnUtil.construct_block_blob(template, bignum(nonce,10).toBuffer({endian : 'little',size : 4}),8,params.pow);

    var header =  Buffer.concat([utils.cnUtil.convert_blob(shareBuffer,8),bignum(nonce,10).toBuffer({endian : 'big',size : 4})]);
    var prooferror = cuHashing.cuckarood29v(header,params.pow);

    if(prooferror){
        log('warn', logSystem, JSON.stringify(params));
        log('warn', logSystem, prooferror);
        log('warn', logSystem, 'Bad hash from miner %s@%s', [miner.login, miner.ip]);
        return false;
    }
    else{
       if(params.pow) hash=cuHashing.cycle_hash(params.pow);
       shareType = 'valid';
       hashDiff = bignum(jobdiff);
    }

    if (hashDiff.ge(blockTemplate.difficulty)){

        apiInterfaces.rpcDaemon('submitblock', [shareBuffer.toString('hex')], function(error, result){
            if (error){
                log('error', logSystem, 'Error submitting block at height %d from %s@%s, share type: "%s" - %j', [job.height, miner.login, miner.ip, shareType, error]);
                recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
            }
            else{
                var blockFastHash = utils.cnUtil.get_block_id(shareBuffer, 8).toString('hex');
                log('info', logSystem,
                    'Block %s found at height %d by miner %s@%s',
                    [blockFastHash.substr(0, 6), job.height, miner.login, miner.ip]
                );
                recordShareData(miner, job, hashDiff.toString(), true, blockFastHash, shareType, blockTemplate);
                jobRefresh();
            }
        });
    }

    else if (hashDiff.lt(job.difficulty)){
        log('warn', logSystem, 'Rejected low difficulty share of %s from %s@%s', [hashDiff.toString(), miner.login, miner.ip]);
        return false;
    }
    else{
        recordShareData(miner, job, hashDiff.toString(), false, null, shareType);
    }

    return true;
}

/**
 * Start pool server on TCP ports
 **/
var httpResponse = ' 200 OK\nContent-Type: text/plain\nContent-Length: 20\n\nMining server online';

function startPoolServerTcp(callback){

    async.each(config.poolServer.ports, function(portData, cback){
        var handleMessage = function(socket, jsonData, pushMessage){
            if (!jsonData.id) {
                log('warn', logSystem, 'Miner RPC request missing RPC id '+JSON.stringify(jsonData));
                return;
            }
            else if (!jsonData.method) {
                log('warn', logSystem, 'Miner RPC request missing RPC method '+JSON.stringify(jsonData));
                return;
            }
            else if (jsonData.id && jsonData.id === "Stratum") {
                // play nice with GGM
            }
            else if (!jsonData.params) {
                log('warn', logSystem, 'Miner RPC request missing RPC params '+JSON.stringify(jsonData));
                return;
            }

            var sendReply = function(error, result, method){
                if(!socket.writable) return;
                var sendData = JSON.stringify({
                    id: jsonData.id,
                    jsonrpc: "2.0",
                    error: error ? {code: -1, message: error} : null,
                    result: result
                }) + "\n";

                if(method) sendData = JSON.stringify({
                    id: jsonData.id,
                    jsonrpc: "2.0",
                    method: method,
                    error: error,
                    result: result
                }) + "\n";
                socket.write(sendData);
            };
            var setMinerid = function(minerid){
                socket.minerId=minerid;
            };

            if(socket.minerId !== 'dummy') {
                if(jsonData.params) jsonData.params.id=socket.minerId;
            }

            if( jsonData.result ) {
                handleMinerMethod(jsonData.method, jsonData.result, socket.remoteAddress, portData, sendReply, pushMessage, setMinerid);
            }
            else{
                if(!jsonData.params && jsonData.method && jsonData.method === "getjobtemplate") return; // GGM quirq
                handleMinerMethod(jsonData.method, jsonData.params, socket.remoteAddress, portData, sendReply, pushMessage, setMinerid);
            }
        };

        var socketResponder = function(socket){
            socket.setKeepAlive(true);
            socket.setEncoding('utf8');

            var dataBuffer = '';

            var pushMessage = function(method, params,id){
                if(!socket.writable) return;
				var sendData = JSON.stringify({
					jsonrpc: "2.o",
					id: id,
					method: method,
					result: params
				}) + "\n";
                socket.write(sendData);
            };

            socket.on('data', function(d){
                dataBuffer += d;
                if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                    dataBuffer = null;
                    log('warn', logSystem, 'Socket flooding detected and prevented from %s', [socket.remoteAddress]);
                    socket.destroy();
                    return;
                }
                if (dataBuffer.indexOf('\n') !== -1){
                    var messages = dataBuffer.split('\n');
                    var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                    for (var i = 0; i < messages.length; i++){
                        var message = messages[i];
                        if (message.trim() === '') continue;
                        var jsonData;
                        try{
                            jsonData = JSON.parse(message);
                        }
                        catch(e){
                            if (message.indexOf('GET /') === 0) {
                                if (message.indexOf('HTTP/1.1') !== -1) {
                                    socket.end('HTTP/1.1' + httpResponse);
                                    break;
                                }
                                else if (message.indexOf('HTTP/1.0') !== -1) {
                                    socket.end('HTTP/1.0' + httpResponse);
                                    break;
                                }
                            }

                            log('warn', logSystem, 'Malformed message from %s: %s', [socket.remoteAddress, message]);
                            socket.destroy();

                            break;
                        }
                        try {
                            handleMessage(socket, jsonData, pushMessage);
                        } catch (e) {
                            log('warn', logSystem, 'Malformed message from ' + socket.remoteAddress + ' generated an exception. Message: ' + message);
                            if (e.message) log('warn', logSystem, 'Exception: ' + e.message);
                        }
                     }
                    dataBuffer = incomplete;
                }
            }).on('error', function(err){
                if (err.code !== 'ECONNRESET')
                    log('warn', logSystem, 'Socket error from %s %j', [socket.remoteAddress, err]);
            }).on('close', function(){
                pushMessage = function(){};
            });
        };

            net.createServer(socketResponder).listen(portData.port, function (error, result) {
                if (error) {
                    log('error', logSystem, 'Could not start server listening on port %d, error: $j', [portData.port, error]);
                    cback(true);
                    return;
                }

                log('info', logSystem, 'Started server listening on port %d', [portData.port]);
                cback();
            });
    }, function(err){
        if (err)
            callback(false);
        else
            callback(true);
    });
}

/**
 * Initialize pool server
 **/

(function init(){
    jobRefresh(true, function(sucessful){ });
})();
