import { createServer } from "https";
import fs from "fs";
import crypto from "crypto";

const options = {
  key: fs.readFileSync("key.pem"),
  cert: fs.readFileSync("cert.pem"),
};

const PORT = 5556;
const WEBSOCKET_MAGIC_STRING_KEY = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SEVEN_BITS_INTEGER_MARKER = 125;
const SIXTEEN_BITS_INTEGER_MARKER = 126;
const SIXTYFOUR_BITS_INTEGER_MARKER = 127;

const MAXIMUM_SIXTEEN_BITS_INTEGER = 2 ** 16; // 0 - 65536
const MAXIMUM_SIXTYFOUR_BITS_INTEGER = 2 ** 64; // 0 - 18446744073709552000

const MASK_KEY_BYTES_LENGTH = 4;
// 1 bit in binary
const OPCODE_TEXT = 0x01;

// One bit in JS. parseInt('10000000', 2) = 128
const ONE_BIT = 128;

const server = createServer(options, (request, response) => {
  response.writeHead(200);
  response.end("Hey there");
}).listen(PORT, () => console.log("Server listening to ", PORT));

server.on("upgrade", onSocketUpgrade);

function onSocketUpgrade(req, socket, head) {
  const { "sec-websocket-key": webClientSocketKey } = req.headers;
  console.log(`${webClientSocketKey} connected!`);
  const headers = prepareHandShakeHeaders(webClientSocketKey);
  console.log(req);
  socket._sockname = webClientSocketKey;
  socket.write(headers);

  socket.on("readable", () => onSocketReadable(socket));
}

function sendMessage(msg, socket) {
  const dataFrameBuffer = prepareMessage(msg);
  socket.write(dataFrameBuffer);
}

function prepareMessage(message) {
  const msg = Buffer.from(message);
  const messageSize = msg.length;

  let dataFrameBuffer;

  //0x80 === 128 in binary;
  // '0x' + Math.abs(128).toString(16) === 0x80
  const firstByte = 0x80 | OPCODE_TEXT; // single frame + utf8 text
  if (messageSize <= SEVEN_BITS_INTEGER_MARKER) {
    const bytes = [firstByte];
    dataFrameBuffer = Buffer.from(bytes.concat(messageSize));
  } else if (messageSize <= MAXIMUM_SIXTEEN_BITS_INTEGER) {
    //alloc 4 bytes
    /*First Position[0]: 
            [0] - 128+1 ==> 128 | 1 or 0x01 | 128
            129.toString(2) ==> 10000001 = 0x81 fincode + opcode

        */
    /*Second Position [1]:
            [1] - 126+0 - payload length marker + mask indicator
        */
    /*Third Position [2]:
            [2] - 0 - content length
        */
    /* Fourth Position [3]: 
            [3] - 171 - content length
            */
    /*[4 - ..] - all remaining bytes of the message*/
    const offsetFourBytes = 4;
    const target = Buffer.allocUnsafe(offsetFourBytes);
    target[0] = [firstByte];
    target[1] = SIXTEEN_BITS_INTEGER_MARKER | 0x0; //just to know the mask

    target.writeUint16BE(messageSize, 2); // Content length is 2 bytes
    dataFrameBuffer = target;
  } else if (messageSize <= MAXIMUM_SIXTYFOUR_BITS_INTEGER) {
    const offsetTenBytes = 10;
    const target = Buffer.allocUnsafe(offsetTenBytes);
    target[0] = [firstByte];
    target[1] = SIXTYFOUR_BITS_INTEGER_MARKER | 0x0; //just to know the mask

    target.writeUint64BE(messageSize, 8); // Content length is 2 bytes
    dataFrameBuffer = target;
  } else {
    throw new Error("message too long :( ");
  }
  const totalLength = dataFrameBuffer.byteLength + messageSize;
  const dataFrameResponse = concat([dataFrameBuffer, msg], totalLength);
  return dataFrameResponse;
}

function concat(bufferList, totalLength) {
  const target = Buffer.allocUnsafe(totalLength);
  let offset = 0;

  for (const buffer of bufferList) {
    target.set(buffer, offset);
    offset += buffer.length;
  }
  return target;
}

function onSocketReadable(socket) {
  console.log(socket.server.ConnectionsList);
  console.log(socket._sockname);
  //consume optcode (first byte)
  socket.read(1);

  //Calculate the size of the payload;
  //1 - 1 byte - 8bits
  // Reading (2nd byte) and remove first bit fron it
  const [markerAndPayloadLength] = socket.read(1);
  // Because the first bit is always 1 for client-server messages
  // you can substract one bit (128 or '10000000' from this byte to get rid of the MASK bit)
  const lengthIndicaterInBits = markerAndPayloadLength - ONE_BIT;

  let messageLength = 0;
  if (lengthIndicaterInBits <= SEVEN_BITS_INTEGER_MARKER) {
    messageLength = lengthIndicaterInBits;
  } else if (lengthIndicaterInBits === SIXTEEN_BITS_INTEGER_MARKER) {
    //unsigned, big-endian 16-bit integer [0-65k] or 2**16
    messageLength = socket.read(2).readUint16BE(0);
  } else if (lengthIndicaterInBits === SIXTYFOUR_BITS_INTEGER_MARKER) {
    //unsigned, big-endian 16-bit integer [0-65k] or 2**16
    messageLength = socket.read(8).readUint64BE(0);
  } else {
    throw new Error(
      "your messages is too long! we don't handle 64-bit messages"
    );
  }

  const maskKey = socket.read(MASK_KEY_BYTES_LENGTH);
  const encoded = socket.read(messageLength);
  const decoded = unmask(encoded, maskKey);
  const received = decoded.toString("utf8");

  console.log(received);
  const data = JSON.parse(received);
  console.log("Message Received socket, ", socket);
  console.log("Message Received, ", data);

  const msg = JSON.stringify({
    message: data,
    at: new Date().toISOString(),
  });
  // const msg = JSON.stringify(data);
  console.log("--------------------------");
  const intervalId = setInterval(() => {
    console.log("+++++++++++++++++++++++++++");
    sendMessage(msg, socket);
  }, 1000);

  setTimeout(() => {
    clearInterval(intervalId);
  }, 2000);
}

function unmask(encodedBuffer, maskKey) {
  // Create the byte Array of decoded payload

  //The mask key has only 4 bytes, index % 4 === 0, 1, 2, 3 = index bits needed to decode the message
  // XOR ^ ==> convert to 2 base digits and returns 1, if both are different otherwise it reutnrs 0.
  // (71).toString(2).padString(8, "0")  = 01000111
  // (53).toString(2).padString(8, "0")  = 00110101
  //                                      ----------
  //                                       01110010
  //parseInt('01110010', 2) = 114
  //String.fromCharCode(114) = r

  //(71 ^ 53).toString(2).padStart(8, "0") = "01110010"
  //String.fromCharCode(parseInt('01110010', 2)) = r

  const fillWithEightZeros = (t) => t.toString().padStart(8, "0");
  const toBinary = (t) => fillWithEightZeros(t.toString(2));
  const fromBinaryToDecimal = (t) => parseInt(toBinary(t), 2);
  const getCharFromBinary = (t) => String.fromCharCode(fromBinaryToDecimal(t));

  const finalBuffer = Buffer.from(encodedBuffer);
  for (let index = 0; index < encodedBuffer.length; index++) {
    finalBuffer[index] =
      encodedBuffer[index] ^ maskKey[index % MASK_KEY_BYTES_LENGTH];

    // const logger = {
    //   unmaskingCalc: `${toBinary(encodedBuffer[index])} ^ ${toBinary(
    //     maskKey[index % MASK_KEY_BYTES_LENGTH]
    //   )} = ${toBinary(finalBuffer[index])}`,
    //   decoded: getCharFromBinary(finalBuffer[index]),
    // };
    // console.log(logger);
  }
  return finalBuffer;

  //   const finalBuffer = Uint8Array.from(
  //     finalBuffer,
  //     (elt, i) => elt ^ maskKey[i % MASK_KEY_BYTES_LENGTH]
  //   );
  //   return String.fromCharCode.apply(null, finalBuffer);
}

function prepareHandShakeHeaders(id) {
  const acceptKey = createSocketAccept(id);
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept:${acceptKey}`,
    `id: ${Math.floor(Math.random() * 1000)}`,
    "",
  ]
    .map((line) => line.concat("\r\n"))
    .join("");
  return headers;
}
function createSocketAccept(id) {
  const shaOne = crypto.createHash("sha1");
  shaOne.update(id + WEBSOCKET_MAGIC_STRING_KEY);
  return shaOne.digest("base64");
}
// Error handling to keep the server on
["uncaughtException", "unhandledRejection"].forEach((event) =>
  process.on(event, (err) => {
    console.error(
      `something bad happened! event ${event}, msg: ${err.stack || err}`
    );
  })
);
