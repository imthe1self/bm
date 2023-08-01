/**
 * Working with objects.  
 * NOTE: Most operations with objects are asynchronous and return
 * promises.
 * @see {@link https://bitmessage.org/wiki/Protocol_specification#Object_types}
 * @module bitmessage/objects
 */

"use strict";

var objectAssign = Object.assign || require("object-assign");
var bufferEqual = require("buffer-equal");
var assert = require("./_util").assert;
var PPromise = require("./platform").Promise;
var bmcrypto = require("./crypto");
var Address = require("./address");
var structs = require("./structs");
var POW = require("./pow");
var util = require("./_util");

var var_int = structs.var_int;
var PubkeyBitfield = structs.PubkeyBitfield;
var message = structs.message;
var object = structs.object;

/**
 * Try to get type of the given encoded object message.
 * Note that this function doesn't do any validation because it is
 * already provided by
 * [object.decode]{@link module:bitmessage/structs.object.decode}
 * routine. Normally you call this for each incoming object message and
 * then call decode function of the appropriate object handler.
 * @param {Buffer} buf - Buffer that starts with encoded object message
 * @return {?number} Object's type if any.
 */
exports.getType = function(buf) {
  // Message header: 4 + 12 + 4 + 4
  // Object header: 8 + 8 + 4
  if (buf.length < 44) {
    return;
  }
  return buf.readUInt32BE(40, true);
};

/**
 * Try to get type of the given object message payload.
 * The same as [getType]{@link module:bitmessage/objects.getType}.
 */
exports.getPayloadType = function(buf) {
  // Object header: 8 + 8 + 4
  if (buf.length < 20) {
    return;
  }
  return buf.readUInt32BE(16, true);
};

// Prepend nonce to a given object without nonce.
function prependNonce(obj, opts) {
  return new PPromise(function(resolve) {
    assert(obj.length <= 262136, "object message payload is too big");
    opts = objectAssign({}, opts);
    var nonce, target, powp;
    if (opts.skipPow) {
      nonce = new Buffer(8);
      nonce.fill(0);
      resolve(Buffer.concat([nonce, obj]));
    } else {
      opts.payloadLength = obj.length + 8;  // Compensate for nonce
      target = POW.getTarget(opts);
      powp = POW.doAsync({target: target, data: obj})
        .then(function(nonce) {
          // TODO(Kagami): We may want to receive nonce as a Buffer from
          // POW module to skip conversion step.
          var payload = new Buffer(opts.payloadLength);
          util.writeUInt64BE(payload, nonce, 0, true);
          obj.copy(payload, 8);
          return payload;
        });
      resolve(powp);
    }
  });
}

/**
 * `getpubkey` object. When a node has the hash of a public key (from an
 * address) but not the public key itself, it must send out a request
 * for the public key.
 * @see {@link https://bitmessage.org/wiki/Protocol_specification#getpubkey}
 * @namespace
 * @static
 */
var getpubkey = exports.getpubkey = {
  /**
   * @typedef {Object} DecodeResult
   * @property {Buffer} nonce - A 8-byte object nonce
   * @property {number} ttl - Time to live in seconds
   * @property {Date} expires - Object expiration date
   * @property {number} type - Object type
   * @property {number} version - Object version
   * @property {number} stream - Object stream
   * @property {number} headerLength - Length of the object header
   * @property {Buffer} ripe - The RIPEMD hash of the requested public
   * keys for address version <= 3
   * @property {Buffer} tag - ...or tag derived from the address object
   * for address version >= 4
   * @property {number} length - Real data length
   * @memberof module:bitmessage/objects.getpubkey
   */

  /**
   * Decode `getpubkey` object message.
   * @param {Buffer} buf - Message
   * @param {Object=} opts - Any of [object.decode]{@link
   * module:bitmessage/structs.object.decode} options
   * @return {Promise.<DecodeResult>} A promise that contains
   * [decoded `getpubkey` structure]{@link
   * module:bitmessage/objects.getpubkey.DecodeResult} when fulfilled.
   */
  decodeAsync: function(buf, opts) {
    return new PPromise(function(resolve) {
      var decoded = message.decode(buf);
      assert(decoded.command === "object", "Bad command");
      resolve(getpubkey.decodePayloadAsync(decoded.payload, opts));
    });
  },

  /**
   * Decode `getpubkey` object message payload.
   * The same as [decodeAsync]{@link
   * module:bitmessage/objects.getpubkey.decodeAsync}.
   */
  decodePayloadAsync: function(buf, opts) {
    return new PPromise(function(resolve) {
      var decoded = object.decodePayload(buf, opts);
      assert(decoded.type === object.GETPUBKEY, "Wrong object type");
      assert(decoded.version >= 2, "getpubkey version is too low");
      assert(decoded.version <= 4, "getpubkey version is too high");
      var objectPayload = util.popkey(decoded, "objectPayload");
      if (decoded.version < 4) {
        assert(objectPayload.length === 20, "getpubkey ripe is too small");
        // Object payload is copied so it's safe to return it right away.
        decoded.ripe = objectPayload;
      } else {
        assert(objectPayload.length === 32, "getpubkey tag is too small");
        // Object payload is copied so it's safe to return it right away.
        decoded.tag = objectPayload;
      }
      resolve(decoded);
    });
  },

  /**
   * Encode `getpubkey` object message.
   * @param {Object} opts - `getpubkey` object options
   * @param {number} opts.ttl - Time to live in seconds
   * @param {Address} opts.to - Receiver of the message
   * @param {boolean=} opts.skipPow - Do not compute POW (false by
   * default)
   * @return {Promise.<Buffer>} A promise that contains encoded message
   * when fulfilled.
   */
  encodeAsync: function(opts) {
    return getpubkey.encodePayloadAsync(opts).then(function(payload) {
      return message.encode("object", payload);
    });
  },

  /**
   * Encode `getpubkey` object message payload.
   * The same as
   * [encodeAsync]{@link module:bitmessage/objects.getpubkey.encodeAsync}.
   */
  encodePayloadAsync: function(opts) {
    return new PPromise(function(resolve) {
      opts = objectAssign({}, opts);
      opts.type = object.GETPUBKEY;
      // Bitmessage address of recepeint of `getpubkey` message.
      var to = Address.decode(opts.to);
      assert(to.version >= 2, "Address version is too low");
      assert(to.version <= 4, "Address version is too high");
      opts.version = to.version;
      opts.stream = to.stream;
      opts.objectPayload = to.version < 4 ? to.ripe : to.getTag();
      var obj = object.encodePayloadWithoutNonce(opts);
      resolve(prependNonce(obj, opts));
    });
  },
};

// Extract pubkey data from decrypted object payload.
function extractPubkey(buf) {
  var decoded = {length: 132};
  // We assume here that input buffer was copied before so it's safe to
  // return reference to it.
  decoded.behavior = PubkeyBitfield(buf.slice(0, 4));
  var signPublicKey = decoded.signPublicKey = new Buffer(65);
  signPublicKey[0] = 4;
  buf.copy(signPublicKey, 1, 4, 68);
  var encPublicKey = decoded.encPublicKey = new Buffer(65);
  encPublicKey[0] = 4;
  buf.copy(encPublicKey, 1, 68, 132);
  return decoded;
}

// Extract pubkey version 3 data from decrypted object payload.
function extractPubkeyV3(buf) {
  var decoded = extractPubkey(buf);
  var decodedTrials = var_int.decode(buf.slice(132));
  decoded.nonceTrialsPerByte = decodedTrials.value;
  decoded.length += decodedTrials.length;
  var decodedExtraBytes = var_int.decode(decodedTrials.rest);
  decoded.payloadLengthExtraBytes = decodedExtraBytes.value;
  decoded.length += decodedExtraBytes.length;
  var decodedSigLength = var_int.decode(decodedExtraBytes.rest);
  var siglen = decodedSigLength.value;
  var rest = decodedSigLength.rest;
  assert(rest.length >= siglen, "Bad pubkey object payload length");
  decoded.signature = rest.slice(0, siglen);
  siglen += decodedSigLength.length;
  decoded._siglen = siglen;  // Internal value
  decoded.length += siglen;
  return decoded;
}

// Note that tag matching only works for address version >= 4.
function findAddrByTag(addrs, tag) {
  var i, addr;
  addrs = addrs || [];
  if (Address.isAddress(addrs)) {
    addrs = [addrs];
  }
  if (Array.isArray(addrs)) {
    for (i = 0; i < addrs.length; i++) {
      addr = addrs[i];
      if (addr.version >= 4 && bufferEqual(addr.getTag(), tag)) {
        return addr;
      }
    }
  } else {
    addr = addrs[tag];
    if (addr && addr.version >= 4) {
      return addr;
    }
  }
}

/**
 * `pubkey` object.
 * @see {@link https://bitmessage.org/wiki/Protocol_specification#pubkey}
 * @namespace
 * @static
 */
var pubkey = exports.pubkey = {
  /**
   * @typedef {Object} DecodeResult
   * @property {Buffer} nonce - A 8-byte object nonce
   * @property {number} ttl - Time to live in seconds
   * @property {Date} expires - Object expiration date
   * @property {number} type - Object type
   * @property {number} version - Object version
   * @property {number} stream - Object stream
   * @property {number} headerLength - Length of the object header
   * @property {Buffer} tag - Tag derived from the address object
   * (present only if object version is 4)
   * @property {Object} behavior - [Pubkey features]{@link
   * module:bitmessage/structs.PubkeyBitfield} that can be expected from
   * the node
   * @property {Buffer} signPublicKey - Signing public key
   * @property {Buffer} encPublicKey - Encryption public key
   * @property {number} nonceTrialsPerByte - Difficulty parameter of the
   * node (present only for `pubkey` version >= 3)
   * @property {number} payloadLengthExtraBytes - Difficulty parameter
   * of the node (present only for `pubkey` version >= 3)
   * @property {Buffer} signature - Signature of the message (present
   * only for `pubkey` version >= 3)
   * @property {number} length - Real data length
   * @memberof module:bitmessage/objects.pubkey
   */

  /**
   * Decode `pubkey` object message.
   * @param {Buffer} buf - Message
   * @param {Object=} opts - Any of [object.decode]{@link
   * module:bitmessage/structs.object.decode} options and:
   * @param {(Address[]|Address|Object)} opts.needed - Address objects
   * which represent pubkeys that we are interested in (used only for
   * pubkeys v4). It is either addresses array or single address or
   * Object addr-by-tag. Time to match the key is O(n), O(1), O(1)
   * respectfully.
   * @return {Promise.<DecodeResult>} A promise that contains
   * [decoded `pubkey` structure]{@link
   * module:bitmessage/objects.pubkey.DecodeResult}
   * when fulfilled.
   */
  decodeAsync: function(buf, opts) {
    return new PPromise(function(resolve) {
      var decoded = message.decode(buf);
      assert(decoded.command === "object", "Bad command");
      resolve(pubkey.decodePayloadAsync(decoded.payload, opts));
    });
  },

  /**
   * Decode `pubkey` object message payload.
   * The same as [decodeAsync]{@link
   * module:bitmessage/objects.pubkey.decodeAsync}.
   */
  decodePayloadAsync: function(buf, opts) {
    return new PPromise(function(resolve) {
      opts = opts || {};
      var decoded = object.decodePayload(buf, opts);
      assert(decoded.type === object.PUBKEY, "Wrong object type");
      var version = decoded.version;
      assert(version >= 2, "Address version is too low");
      assert(version <= 4, "Address version is too high");
      var objectPayload = util.popkey(decoded, "objectPayload");
      var siglen, pos, sig, dataToVerify, pubkeyp;
      var tag, addr, pubkeyPrivateKey, dataToDecrypt;

      // v2 pubkey.
      if (version === 2) {
        // 4 + 64 + 64
        assert(
          objectPayload.length === 132,
          "Bad pubkey v2 object payload length");
        objectAssign(decoded, extractPubkey(objectPayload));
        return resolve(decoded);
      }

      // v3 pubkey.
      if (version === 3) {
        // 4 + 64 + 64 + (1+) + (1+) + (1+)
        assert(
          objectPayload.length >= 135,
          "Bad pubkey v3 object payload length");
        objectAssign(decoded, extractPubkeyV3(objectPayload));
        siglen = util.popkey(decoded, "_siglen");
        pos = decoded.headerLength + decoded.length - siglen;
        // Object message payload from `expiresTime` up to `sig_length`.
        dataToVerify = buf.slice(8, pos);
        sig = decoded.signature;
        pubkeyp = bmcrypto.verify(decoded.signPublicKey, dataToVerify, sig)
          .then(function() {
            return decoded;
          });
        return resolve(pubkeyp);
      }

      // v4 pubkey.
      assert(objectPayload.length >= 32, "Bad pubkey v4 object payload length");
      tag = decoded.tag = objectPayload.slice(0, 32);
      addr = findAddrByTag(opts.needed, tag);
      assert(addr, "You are not interested in this pubkey v4");
      pubkeyPrivateKey = addr.getPubkeyPrivateKey();
      dataToDecrypt = objectPayload.slice(32);
      pubkeyp = bmcrypto
        .decrypt(pubkeyPrivateKey, dataToDecrypt)
        .then(function(decrypted) {
          // 4 + 64 + 64 + (1+) + (1+) + (1+)
          assert(
            decrypted.length >= 135,
            "Bad pubkey v4 object payload length");
          objectAssign(decoded, extractPubkeyV3(decrypted));
          siglen = util.popkey(decoded, "_siglen");
          dataToVerify = Buffer.concat([
            // Object header without nonce + tag.
            buf.slice(8, decoded.headerLength + 32),
            // Unencrypted pubkey data without signature.
            decrypted.slice(0, decoded.length - siglen),
          ]);
          sig = decoded.signature;
          // Since data is encrypted, entire object payload is used.
          decoded.length = objectPayload.length;
          return bmcrypto.verify(decoded.signPublicKey, dataToVerify, sig);
        }).then(function() {
          return decoded;
        });
      resolve(pubkeyp);
    });
  },

  /**
   * Encode `pubkey` object message.
   * @param {Object} opts - `pubkey` object options
   * @param {number} opts.ttl - Time to live in seconds
   * @param {Address} opts.from - Originator of the message
   * @param {Address} opts.to - Receiver of the message
   * @param {boolean=} opts.skipPow - Do not compute POW (false by
   * default)
   * @return {Promise.<Buffer>} A promise that contains encoded message
   * when fulfilled.
   */
  encodeAsync: function(opts) {
    return pubkey.encodePayloadAsync(opts).then(function(payload) {
      return message.encode("object", payload);
    });
  },

  /**
   * Encode `pubkey` object message payload.
   * The same as [encodeAsync]{@link
   * module:bitmessage/objects.pubkey.encodeAsync}.
   */
  encodePayloadAsync: function(opts) {
    return new PPromise(function(resolve) {
      opts = objectAssign({}, opts);
      opts.type = object.PUBKEY;
      // Originator of `pubkey` message.
      var from = Address.decode(opts.from);
      var nonceTrialsPerByte = util.getTrials(from);
      var payloadLengthExtraBytes = util.getExtraBytes(from);
      // Bitmessage address of recepient of `pubkey` message.
      var to, version, stream;
      if (opts.to) {
        to = Address.decode(opts.to);
        version = to.version;
        stream = to.stream;
      } else {
        version = opts.version || 4;
        stream = opts.stream || 1;
      }
      assert(version >= 2, "Address version is too low");
      assert(version <= 4, "Address version is too high");
      opts.version = version;
      opts.stream = stream;
      var obj, pubkeyp;

      // v2 pubkey.
      if (version === 2) {
        opts.objectPayload = Buffer.concat([
          from.behavior.buffer,
          from.signPublicKey.slice(1),
          from.encPublicKey.slice(1),
        ]);
        obj = object.encodePayloadWithoutNonce(opts);
        return resolve(prependNonce(obj, opts));
      }

      var pubkeyData = [
        from.behavior.buffer,
        from.signPublicKey.slice(1),
        from.encPublicKey.slice(1),
        var_int.encode(nonceTrialsPerByte),
        var_int.encode(payloadLengthExtraBytes),
      ];

      // v3 pubkey.
      if (version === 3) {
        opts.objectPayload = Buffer.concat(pubkeyData);
        obj = object.encodePayloadWithoutNonce(opts);
        pubkeyp = bmcrypto
          .sign(from.signPrivateKey, obj)
          .then(function(sig) {
            // Append signature to the encoded object and we are done.
            obj = Buffer.concat([obj, var_int.encode(sig.length), sig]);
            return prependNonce(obj, opts);
          });
        return resolve(pubkeyp);
      }

      // v4 pubkey.
      opts.objectPayload = from.getTag();
      obj = object.encodePayloadWithoutNonce(opts);
      var dataToSign = Buffer.concat([obj].concat(pubkeyData));
      pubkeyp = bmcrypto
        .sign(from.signPrivateKey, dataToSign)
        .then(function(sig) {
          var dataToEnc = pubkeyData.concat(var_int.encode(sig.length), sig);
          dataToEnc = Buffer.concat(dataToEnc);
          return bmcrypto.encrypt(from.getPubkeyPublicKey(), dataToEnc);
        }).then(function(enc) {
          // Concat object header with ecnrypted data and we are done.
          obj = Buffer.concat([obj, enc]);
          return prependNonce(obj, opts);
        });
      resolve(pubkeyp);
    });
  },
};

// Try to decrypt message with all provided identities.
function tryDecryptMsg(identities, buf) {
  function inner(i) {
    if (i > last) {
      return PPromise.reject(
        new Error("Failed to decrypt msg with given identities")
      );
    }
    return bmcrypto
      .decrypt(identities[i].encPrivateKey, buf)
      .then(function(decrypted) {
        return {addr: identities[i], decrypted: decrypted};
      }).catch(function() {
        return inner(i + 1);
      });
  }

  if (Address.isAddress(identities)) {
    identities = [identities];
  }
  var last = identities.length - 1;
  return inner(0);
}

// Encode message from the given options.
function encodeMessage(opts) {
  var encoding = opts.encoding || DEFAULT_ENCODING;
  var message = opts.message;
  var subject = opts.subject;
  if (encoding === msg.IGNORE && !message) {
    // User may omit message for IGNORE encoding.
    message = new Buffer(0);
  } else if (!Buffer.isBuffer(message)) {
    // User may specify message as a string.
    message = new Buffer(message, "utf8");
  }
  if (encoding === msg.SIMPLE && subject) {
    // User may specify subject for SIMPLE encoding.
    if (!Buffer.isBuffer(subject)) {
      subject = new Buffer(subject, "utf8");
    }
    message = Buffer.concat([
      new Buffer("Subject:"),
      subject,
      new Buffer("\nBody:"),
      message,
    ]);
  }
  return message;
}

// Decode message to the given encoding.
function decodeMessage(message, encoding) {
  var decoded = {};
  if (encoding === msg.TRIVIAL || encoding === msg.SIMPLE) {
    message = message.toString("utf8");
  }
  if (encoding !== msg.SIMPLE) {
    decoded.message = message;
    return decoded;
  }

  // SIMPLE.
  var subject, index;
  if (message.slice(0, 8) === "Subject:") {
    subject = message.slice(8);
    index = subject.indexOf("\nBody:");
    if (index !== -1) {
      message = subject.slice(index + 6);
      subject = subject.slice(0, index);
    } else {
      message = "";
    }
    decoded.subject = subject;
    decoded.message = message;
  } else {
    decoded.subject = "";
    decoded.message = message;
  }
  return decoded;
}

/**
 * `msg` object.
 * @see {@link https://bitmessage.org/wiki/Protocol_specification#msg}
 * @namespace
 * @static
 */
var msg = exports.msg = {
  /**
   * Any data with this number may be ignored. The sending node might
   * simply be sharing its public key with you.
   * @constant {number}
   */
  IGNORE: 0,
  /**
   * UTF-8. No 'Subject' or 'Body' sections. Useful for simple strings
   * of data, like URIs or magnet links.
   * @constant {number}
   */
  TRIVIAL: 1,
  /**
   * UTF-8. Uses 'Subject' and 'Body' sections. No MIME is used.
   * @constant {number}
   */
  SIMPLE: 2,

  /**
   * @typedef {Object} DecodeResult
   * @property {Buffer} nonce - A 8-byte object nonce
   * @property {number} ttl - Time to live in seconds
   * @property {Date} expires - Object expiration date
   * @property {number} type - Object type
   * @property {number} version - Object version
   * @property {number} stream - Object stream
   * @property {number} headerLength - Length of the object header
   * @property {number} senderVersion - Sender's address version
   * @property {number} senderStream - Sender's stream
   * @property {Object} behavior - Sender's [pubkey features]{@link
   * module:bitmessage/structs.PubkeyBitfield} that can be expected from
   * the node
   * @property {Buffer} signPublicKey - Sender's signing public key
   * @property {Buffer} encPublicKey - Sender's encryption public key
   * @property {number} nonceTrialsPerByte - Difficulty parameter of the
   * sender (present only if sender's address version >= 3)
   * @property {number} payloadLengthExtraBytes - Difficulty parameter
   * of the sender (present only if sender's address version >= 3)
   * @property {Buffer} ripe - The RIPEMD hash of the receiver's keys
   * @property {number} encoding - Message encoding
   * @property {(string|Buffer)} message - Message string for
   * [TRIVIAL]{@link module:bitmessage/objects.msg.TRIVIAL} and
   * [SIMPLE]{@link module:bitmessage/objects.msg.SIMPLE} encodings or
   * unparsed buffer data for other encodings
   * @property {string=} subject - Subject string for [SIMPLE]{@link
   * module:bitmessage/objects.msg.SIMPLE} encoding
   * @property {Buffer} ack - Message acknowledgement
   * @property {Buffer} signature - Signature of the message
   * @property {number} length - Real data length
   * @memberof module:bitmessage/objects.msg
   */

  /**
   * Decode `msg` object message.
   * @param {Buffer} buf - Message
   * @param {Object} opts - Any of [object.decode]{@link
   * module:bitmessage/structs.object.decode} options and:
   * @param {(Address[]|Address)} opts.identities - Address objects used
   * to decrypt the message
   * @return {Promise.<DecodeResult>} A promise that contains [decoded
   * `msg` structure]{@link module:bitmessage/objects.msg.DecodeResult}
   * when fulfilled.
   */
  decodeAsync: function(buf, opts) {
    return new PPromise(function(resolve) {
      var decoded = message.decode(buf);
      assert(decoded.command === "object", "Bad command");
      resolve(msg.decodePayloadAsync(decoded.payload, opts));
    });
  },

  /**
   * Decode `msg` object message payload.
   * The same as [decodeAsync]{@link
   * module:bitmessage/objects.msg.decodeAsync}.
   */
  decodePayloadAsync: function(buf, opts) {
    return new PPromise(function(resolve) {
      var decoded = object.decodePayload(buf, opts);
      assert(decoded.type === object.MSG, "Bad object type");
      assert(decoded.version === 1, "Bad msg version");
      var objectPayload = util.popkey(decoded, "objectPayload");

      var msgp = tryDecryptMsg(opts.identities, objectPayload)
        .then(function(decInfo) {
          var decrypted = decInfo.decrypted;

          // Version, stream.
          var decodedVersion = var_int.decode(decrypted);
          var senderVersion = decoded.senderVersion = decodedVersion.value;
          assert(senderVersion >= 2, "Sender version is too low");
          assert(senderVersion <= 4, "Sender version is too high");
          var decodedStream = var_int.decode(decodedVersion.rest);
          decoded.senderStream = decodedStream.value;

          // Behavior, keys.
          assert(
            decodedStream.rest.length >= 132,
            "Bad msg object payload length");
          objectAssign(decoded, extractPubkey(decodedStream.rest));
          decoded.length += decodedVersion.length + decodedStream.length;
          var rest = decrypted.slice(decoded.length);

          // Pow extra.
          if (senderVersion >= 3) {
            var decodedTrials = var_int.decode(rest);
            decoded.nonceTrialsPerByte = decodedTrials.value;
            decoded.length += decodedTrials.length;
            var decodedExtraBytes = var_int.decode(decodedTrials.rest);
            decoded.payloadLengthExtraBytes = decodedExtraBytes.value;
            decoded.length += decodedExtraBytes.length;
            rest = decodedExtraBytes.rest;
          }

          // Ripe, encoding.
          assert(rest.length >= 20, "Bad msg object payload length");
          decoded.ripe = rest.slice(0, 20);
          // TODO(Kagami): Also check against the calculated ripe (see
          // GH-6)?
          assert(
            bufferEqual(decoded.ripe, decInfo.addr.ripe),
            "msg was decrypted but the destination ripe doesn't match");
          decoded.length += 20;
          var decodedEncoding = var_int.decode(rest.slice(20));
          var encoding = decoded.encoding = decodedEncoding.value;
          decoded.length += decodedEncoding.length;

          // Message.
          var decodedMsgLength = var_int.decode(decodedEncoding.rest);
          var msglen = decodedMsgLength.value;
          rest = decodedMsgLength.rest;
          assert(rest.length >= msglen, "Bad msg object payload length");
          decoded.length += decodedMsgLength.length + msglen;
          var message = rest.slice(0, msglen);
          objectAssign(decoded, decodeMessage(message, encoding));

          // Acknowledgement data.
          // TODO(Kagami): Validate ack, check a POW.
          var decodedAckLength = var_int.decode(rest.slice(msglen));
          var acklen = decodedAckLength.value;
          rest = decodedAckLength.rest;
          assert(rest.length >= acklen, "Bad msg object payload length");
          decoded.length += decodedAckLength.length + acklen;
          decoded.ack = rest.slice(0, acklen);

          // Signature.
          var decodedSigLength = var_int.decode(rest.slice(acklen));
          var siglen = decodedSigLength.value;
          rest = decodedSigLength.rest;
          assert(rest.length >= siglen, "Bad msg object payload length");
          var sig = decoded.signature = rest.slice(0, siglen);

          // Verify signature.
          var dataToVerify = Buffer.concat([
            // Object header without nonce.
            buf.slice(8, decoded.headerLength),
            // Unencrypted pubkey data without signature.
            decrypted.slice(0, decoded.length),
          ]);
          // Since data is encrypted, entire object payload is used.
          decoded.length = objectPayload.length;
          return bmcrypto.verify(decoded.signPublicKey, dataToVerify, sig);
        }).then(function() {
          return decoded;
        });
      resolve(msgp);
    });
  },

  /**
   * Encode `msg` object message.
   * @param {Object} opts - `msg` object options
   * @param {number} opts.ttl - Time to live in seconds
   * @param {Address} opts.from - Originator of the message
   * @param {Address} opts.to - Receiver of the message
   * @param {(string|Buffer)} opts.message - Message
   * @param {(string|Buffer)=} opts.subject - Subject for [SIMPLE]{@link
   * module:bitmessage/objects.msg.SIMPLE} encoding
   * @param {number=} opts.encoding - Encoding of the message
   * ([TRIVIAL]{@link module:bitmessage/objects.msg.TRIVIAL} by default)
   * @param {boolean=} opts.friend - Whether the receiver is friend and
   * should have minimal POW difficulty (false by default)
   * @param {boolean=} opts.skipPow - Do not compute POW (false by
   * default)
   * @return {Promise.<Buffer>} A promise that contains encoded message
   * when fulfilled.
   */
  encodeAsync: function(opts) {
    return msg.encodePayloadAsync(opts).then(function(payload) {
      // return message.encode("object", payload);
      return payload;
    });
  },

  /**
   * Encode `msg` object message payload.
   * The same as [encodeAsync]{@link
   * module:bitmessage/objects.msg.encodeAsync}.
   */
  encodePayloadAsync: function(opts) {
    return new PPromise(function(resolve) {
      // Deal with options.
      opts = objectAssign({}, opts);
      opts.type = object.MSG;
      opts.version = 1;  // The only known msg version
      var from = Address.decode(opts.from);
      assert(from.version >= 2, "Address version is too low");
      assert(from.version <= 4, "Address version is too high");
      var to = Address.decode(opts.to);
      opts.stream = to.stream;
      var nonceTrialsPerByte, payloadLengthExtraBytes;
      if (from.version >= 3) {
        if (opts.friend) {
          nonceTrialsPerByte = util.DEFAULT_TRIALS_PER_BYTE;
          payloadLengthExtraBytes = util.DEFAULT_EXTRA_BYTES;
        } else {
          nonceTrialsPerByte = util.getTrials(from);
          payloadLengthExtraBytes = util.getExtraBytes(from);
        }
      }
      var encoding = opts.encoding || DEFAULT_ENCODING;
      var message = encodeMessage(opts);

      // Assemble the unencrypted message data.
      var msgData = [
        var_int.encode(from.version),
        var_int.encode(from.stream),
        from.behavior.buffer,
        from.signPublicKey.slice(1),
        from.encPublicKey.slice(1),
      ];
      if (from.version >= 3) {
        msgData.push(
          var_int.encode(nonceTrialsPerByte),
          var_int.encode(payloadLengthExtraBytes)
        );
      }
      msgData.push(
        to.ripe,
        var_int.encode(encoding),
        var_int.encode(message.length),
        message
      );
      // TODO(Kagami): Calculate ACK.
      msgData.push(var_int.encode(0));

      // Sign and encrypt.
      opts.objectPayload = new Buffer(0);
      var obj = object.encodePayloadWithoutNonce(opts);
      var dataToSign = Buffer.concat([obj].concat(msgData));
      var msgp = bmcrypto
        .sign(from.signPrivateKey, dataToSign)
        .then(function(sig) {
          var dataToEnc = msgData.concat(var_int.encode(sig.length), sig);
          dataToEnc = Buffer.concat(dataToEnc);
          return bmcrypto.encrypt(to.encPublicKey, dataToEnc);
        }).then(function(enc) {
          // Concat object header with ecnrypted data and we are done.
          obj = Buffer.concat([obj, enc]);
          // TODO(Kagami): Merge receiver's trials/extra bytes options
          // so we can calculate right POW (now we need to pass them to
          // opts manually).
          // return prependNonce(obj, opts);
          return { objWithNonce: prependNonce(obj, opts), obj };
        });
      resolve(msgp);
    });
  },
};

var DEFAULT_ENCODING = msg.TRIVIAL;

// Try to decrypt broadcast v4 with all provided subscription objects.
function tryDecryptBroadcastV4(subscriptions, buf) {
  function inner(i) {
    if (i > last) {
      return PPromise.reject(
        new Error("Failed to decrypt broadcast with given identities")
      );
    }
    return bmcrypto
      .decrypt(subscriptions[i].getBroadcastPrivateKey(), buf)
      .then(function(decrypted) {
        return {addr: subscriptions[i], decrypted: decrypted};
      }).catch(function() {
        return inner(i + 1);
      });
  }

  if (Address.isAddress(subscriptions)) {
    subscriptions = [subscriptions];
  } else if (!Array.isArray(subscriptions)) {
    subscriptions = Object.keys(subscriptions).map(function(k) {
      return subscriptions[k];
    });
  }
  // Only addresses with version < 4 may be used to encode broadcast v4.
  subscriptions = subscriptions.filter(function(a) {
    return a.version < 4;
  });
  var last = subscriptions.length - 1;
  return inner(0);
}

/**
 * `broadcast` object.
 * @see {@link https://bitmessage.org/wiki/Protocol_specification#broadcast}
 * @namespace
 * @static
 */
var broadcast = exports.broadcast = {
  /**
   * @typedef {Object} DecodeResult
   * @property {Buffer} nonce - A 8-byte object nonce
   * @property {number} ttl - Time to live in seconds
   * @property {Date} expires - Object expiration date
   * @property {number} type - Object type
   * @property {number} version - Object version
   * @property {number} stream - Object stream
   * @property {number} headerLength - Length of the object header
   * @property {Buffer} tag - Tag derived from the address object used
   * to send this `broadcast` (present only for object version >= 5)
   * @property {number} senderVersion - Sender's address version
   * @property {number} senderStream - Sender's stream
   * @property {Object} behavior - Sender's [pubkey features]{@link
   * module:bitmessage/structs.PubkeyBitfield} that can be expected from
   * the node
   * @property {Buffer} signPublicKey - Sender's signing public key
   * @property {Buffer} encPublicKey - Sender's encryption public key
   * @property {number} nonceTrialsPerByte - Difficulty parameter of the
   * sender (present only if sender's address version >= 3)
   * @property {number} payloadLengthExtraBytes - Difficulty parameter
   * of the sender (present only if sender's address version >= 3)
   * @property {number} encoding - Message encoding
   * @property {(string|Buffer)} message - Message string for
   * [TRIVIAL]{@link module:bitmessage/objects.msg.TRIVIAL} and
   * [SIMPLE]{@link module:bitmessage/objects.msg.SIMPLE} encodings or
   * unparsed buffer data for other encodings
   * @property {string=} subject - Subject string for [SIMPLE]{@link
   * module:bitmessage/objects.msg.SIMPLE} encoding
   * @property {Buffer} signature - Signature of the message
   * @property {number} length - Real data length
   * @memberof module:bitmessage/objects.broadcast
   */

  /**
   * Decode `broadcast` object message.
   * @param {Buffer} buf - Message
   * @param {Object} opts - Any of [object.decode]{@link
   * module:bitmessage/structs.object.decode} options and:
   * @param {(Address[]|Address|Object)} opts.subscriptions - Address
   * objects which represent broadcast subscriptions. It is either
   * addresses array or single address or Object
   * addr-by-tag/addr-by-ripe. Time to match the key is O(n), O(1), O(1)
   * respectfully.
   * @return {Promise.<DecodeResult>} A promise that contains
   * [decoded `broadcast` structure]{@link
   * module:bitmessage/objects.broadcast.DecodeResult} when fulfilled.
   */
  decodeAsync: function(buf, opts) {
    return new PPromise(function(resolve) {
      var decoded = message.decode(buf);
      assert(decoded.command === "object", "Bad command");
      resolve(broadcast.decodePayloadAsync(decoded.payload, opts));
    });
  },

  /**
   * Decode `broadcast` object message payload.
   * The same as [decodeAsync]{@link
   * module:bitmessage/objects.broadcast.decodeAsync}.
   */
  decodePayloadAsync: function(buf, opts) {
    return new PPromise(function(resolve) {
      var decoded = object.decodePayload(buf, opts);
      assert(decoded.type === object.BROADCAST, "Bad object type");
      var version = decoded.version;
      assert(version === 4 || version === 5, "Bad broadcast version");
      var objectPayload = util.popkey(decoded, "objectPayload");
      var tag, addr, broadPrivateKey, dataToDecrypt, broadp;

      if (version === 4) {
        broadp = tryDecryptBroadcastV4(opts.subscriptions, objectPayload);
      } else {
        assert(
          objectPayload.length >= 32,
          "Bad broadcast v5 object payload length");
        tag = decoded.tag = objectPayload.slice(0, 32);
        addr = findAddrByTag(opts.subscriptions, tag);
        assert(addr, "You are not interested in this broadcast v5");
        broadPrivateKey = addr.getBroadcastPrivateKey();
        dataToDecrypt = objectPayload.slice(32);
        broadp = bmcrypto
          .decrypt(broadPrivateKey, dataToDecrypt)
          .then(function(decrypted) {
            return {addr: addr, decrypted: decrypted};
          });
      }

      broadp = broadp.then(function(decInfo) {
        var decrypted = decInfo.decrypted;

        // Version, stream.
        var decodedVersion = var_int.decode(decrypted);
        var senderVersion = decoded.senderVersion = decodedVersion.value;
        if (version === 4) {
          assert(senderVersion >= 2, "Sender version is too low");
          assert(senderVersion <= 3, "Sender version is too high");
        } else {
          assert(senderVersion === 4, "Bad sender version");
        }
        var decodedStream = var_int.decode(decodedVersion.rest);
        var senderStream = decoded.senderStream = decodedStream.value;
        assert(
          senderStream === decoded.stream,
          "Cleartext broadcast object stream doesn't match encrypted");

        // Behavior, keys.
        assert(
          decodedStream.rest.length >= 132,
          "Bad broadcast object payload length");
        objectAssign(decoded, extractPubkey(decodedStream.rest));
        decoded.length += decodedVersion.length + decodedStream.length;
        var rest = decrypted.slice(decoded.length);
        var sender = new Address({
          version: senderVersion,
          stream: senderStream,
          signPublicKey: decoded.signPublicKey,
          encPublicKey: decoded.encPublicKey,
        });
        if (version === 4) {
          assert(
            bufferEqual(sender.ripe, decInfo.addr.ripe),
            "The keys used to encrypt the broadcast doesn't match the keys "+
            "embedded into the object");
        } else {
          assert(
            bufferEqual(sender.getTag(), tag),
            "The tag used to encrypt the broadcast doesn't match the keys "+
            "and version/stream embedded into the object");
        }

        // Pow extra.
        if (senderVersion >= 3) {
          var decodedTrials = var_int.decode(rest);
          decoded.nonceTrialsPerByte = decodedTrials.value;
          decoded.length += decodedTrials.length;
          var decodedExtraBytes = var_int.decode(decodedTrials.rest);
          decoded.payloadLengthExtraBytes = decodedExtraBytes.value;
          decoded.length += decodedExtraBytes.length;
          rest = decodedExtraBytes.rest;
        }

        // Encoding, message
        var decodedEncoding = var_int.decode(rest);
        var encoding = decoded.encoding = decodedEncoding.value;
        decoded.length += decodedEncoding.length;
        var decodedMsgLength = var_int.decode(decodedEncoding.rest);
        var msglen = decodedMsgLength.value;
        rest = decodedMsgLength.rest;
        assert(rest.length >= msglen, "Bad broadcast object payload length");
        decoded.length += decodedMsgLength.length + msglen;
        var message = rest.slice(0, msglen);
        objectAssign(decoded, decodeMessage(message, encoding));

        // Signature.
        var decodedSigLength = var_int.decode(rest.slice(msglen));
        var siglen = decodedSigLength.value;
        rest = decodedSigLength.rest;
        assert(rest.length >= siglen, "Bad broadcast object payload length");
        var sig = decoded.signature = rest.slice(0, siglen);

        // Verify signature.
        var headerLength = decoded.headerLength;
        if (version !== 4) {
          // Compensate for tag.
          headerLength += 32;
        }
        var dataToVerify = Buffer.concat([
          // Object header without nonce.
          buf.slice(8, headerLength),
          // Unencrypted pubkey data without signature.
          decrypted.slice(0, decoded.length),
        ]);
        // Since data is encrypted, entire object payload is used.
        decoded.length = objectPayload.length;
        return bmcrypto.verify(decoded.signPublicKey, dataToVerify, sig);
      }).then(function() {
        return decoded;
      });
      resolve(broadp);
    });
  },

  /**
   * Encode `broadcast` object message.
   * @param {Object} opts - `broadcast` object options
   * @param {number} opts.ttl - Time to live in seconds
   * @param {Address} opts.from - Originator of the message
   * @param {(string|Buffer)} opts.message - Message
   * @param {(string|Buffer)=} opts.subject - Subject for [SIMPLE]{@link
   * module:bitmessage/objects.msg.SIMPLE} encoding
   * @param {number=} opts.encoding - Encoding of the message
   * ([TRIVIAL]{@link module:bitmessage/objects.msg.TRIVIAL} by default)
   * @param {boolean=} opts.skipPow - Do not compute POW (false by
   * default)
   * @return {Promise.<Buffer>} A promise that contains encoded message
   * when fulfilled.
   */
  encodeAsync: function(opts) {
    return broadcast.encodePayloadAsync(opts).then(function(payload) {
      // return message.encode("object", payload);
      return payload;
    });
  },

  /**
   * Encode `broadcast` object message payload.
   * The same as [encodeAsync]{@link
   * module:bitmessage/objects.broadcast.encodeAsync}.
   */
  encodePayloadAsync: function(opts) {
    return new PPromise(function(resolve) {
      // Deal with options.
      opts = objectAssign({}, opts);
      opts.type = object.BROADCAST;
      var from = Address.decode(opts.from);
      assert(from.version >= 2, "Address version is too low");
      assert(from.version <= 4, "Address version is too high");
      opts.version = from.version >= 4 ? 5 : 4;
      opts.stream = from.stream;
      var encoding = opts.encoding || DEFAULT_ENCODING;
      var message = encodeMessage(opts);

      // Assemble the unencrypted message data.
      var broadData = [
        var_int.encode(from.version),
        var_int.encode(from.stream),
        from.behavior.buffer,
        from.signPublicKey.slice(1),
        from.encPublicKey.slice(1),
      ];
      if (from.version >= 3) {
        broadData.push(
          var_int.encode(util.getTrials(from)),
          var_int.encode(util.getExtraBytes(from))
        );
      }
      broadData.push(
        var_int.encode(encoding),
        var_int.encode(message.length),
        message
      );

      // Sign and encrypt.
      opts.objectPayload = from.version >= 4 ? from.getTag() : new Buffer(0);
      var obj = object.encodePayloadWithoutNonce(opts);
      var dataToSign = Buffer.concat([obj].concat(broadData));
      var broadp = bmcrypto
        .sign(from.signPrivateKey, dataToSign)
        .then(function(sig) {
          var dataToEnc = broadData.concat(var_int.encode(sig.length), sig);
          dataToEnc = Buffer.concat(dataToEnc);
          return bmcrypto.encrypt(from.getBroadcastPublicKey(), dataToEnc);
        }).then(function(enc) {
          obj = Buffer.concat([obj, enc]);
          // return prependNonce(obj, opts);
          return { objWithNonce: prependNonce(obj, opts), obj };
        });
      resolve(broadp);
    });
  },
};
