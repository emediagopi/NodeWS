1. Taken it from https://www.youtube.com/watch?v=qFoFKLI3O8w

2. run the inde.html directly in the browser not using localhost like "file:///C:/Gopi/Projects/Learn/ScratchWebSocket/nodejs-raw-ws/index.html". In server upgrade listener (nodeJS console), you will get the "sec-websocket-key"



3. take the static magic key from "https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers#server_handshake_response" which is "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

4. Create a SHA-1 hash with bash64 encoded.
    import crypto from NodeJS and update it with sha1 format (concodinate the "sec-websocket-key" + "magicKey") then return it as base64 format

5. How much is 1 bit in JS
    parseInt('10000000', 2)
