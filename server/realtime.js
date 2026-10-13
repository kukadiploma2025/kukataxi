// Живые обновления через Server-Sent Events: у каждого пользователя может быть несколько вкладок.
const clients = new Map(); // userId -> Set<res>

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  res.on('close', () => {
    const s = clients.get(userId);
    if (s) { s.delete(res); if (!s.size) clients.delete(userId); }
  });
}

export function push(userId, event, data = {}) {
  const s = clients.get(userId);
  if (!s) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of s) res.write(payload);
}

export function pushMany(userIds, event, data) {
  for (const id of userIds) push(id, event, data);
}

export function heartbeat() {
  for (const s of clients.values()) for (const res of s) res.write(': ping\n\n');
}

export const isOnline = (userId) => clients.has(userId);
