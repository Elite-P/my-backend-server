const http = require('http');

// Lấy cổng do cloud cung cấp, nếu chạy ở máy thì mặc định là 3000
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Server backend cua toi da chay tren cloud!\n');
});

server.listen(PORT, () => {
  console.log(`Server đang chạy tại cổng ${PORT}`);
});