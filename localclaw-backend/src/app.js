import http from 'node:http';

const port = Number(process.env.PORT || '3000');

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('localclaw service is running');
});

server.listen(port, () => {
  console.log(`service listening on ${port}`);
});
