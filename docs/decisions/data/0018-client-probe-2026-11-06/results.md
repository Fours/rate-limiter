# Redis clients when Redis is killed, paused or absent

Milestone 4, T0. What one `PING` does in each case, capped at 2 s (3 s for the baseline), and how the client recovers.

## Setup

- Apple M5 Pro, macOS (Darwin 25.4.0), Docker 29.4.1
- Node v25.8.2 on the host, ioredis 6.0.0, redis (node-redis) 6.3.1
- Redis `redis:7.4.12-alpine` in a throwaway container on port 6391, no persistence
- Faults: `docker kill` then `docker start`; `docker pause` then `docker unpause`; a client pointed at a closed port
- Command: `node docs/decisions/data/0018-client-probe-2026-11-06/probe.mjs` (needs Docker; `npm install` first)

## Results

Each fault: three commands 200 ms apart while Redis is down, then the time from `start`/`unpause` to the first command that succeeds, and what became of the three.

| Client and settings | Killed | Paused | Closed port | Back after start / unpause | The three commands |
| --- | --- | --- | --- | --- | --- |
| ioredis, default | no answer in 2 s (queued) | no answer in 2 s | no answer in 2 s | 163 ms / 76 ms | kill: all 3 ran once Redis was back; pause: all 3 ran |
| ioredis, `enableOfflineQueue: false` | error in 0.1 ms | no answer in 2 s | error in 0.3 ms | 469 ms / 81 ms | kill: 3 errors; pause: all 3 ran |
| node-redis, default | no answer in 2 s (queued) | no answer in 2 s | no answer in 2 s | 923 ms / 84 ms | kill: 2 errors, 1 ran; pause: all 3 ran |
| node-redis, `disableOfflineQueue: true` | error in 0.1 ms | no answer in 2 s | error in 0.1 ms | 206 ms / 82 ms | kill: 3 errors; pause: all 3 ran |

Errors seen: ioredis `Stream isn't writeable and enableOfflineQueue options is false`; node-redis `The client is offline`.

With the offline queue off, ioredis also refuses commands sent before its first connection is ready, so an app should wait for `ready` (or `connect()`) before serving.

## Raw output

The first configuration came from a first run, which then stopped on that last point; the other three from a second run with the probe fixed to wait for `ready`.

```
## ioredis default, kill
  baseline 0.7 ms ok
  during #1: 2003.0 ms no answer in 2000 ms
  during #2: 2001.1 ms no answer in 2000 ms
  during #3: 2001.2 ms no answer in 2000 ms
  back: first ok 163 ms after start
  commands sent during the fault ended: ok, ok, ok

## ioredis default, pause
  baseline 0.5 ms ok
  during #1: 2001.6 ms no answer in 2000 ms
  during #2: 2001.1 ms no answer in 2000 ms
  during #3: 2000.8 ms no answer in 2000 ms
  back: first ok 76 ms after unpause
  commands sent during the fault ended: ok, ok, ok

## ioredis default, closed port
  2002.6 ms no answer in 2000 ms
  2002.2 ms no answer in 2000 ms

## ioredis enableOfflineQueue:false, kill
  baseline 0.6 ms ok
  during #1: 0.1 ms err: Stream isn't writeable and enableOfflineQueue options is false
  during #2: 0.1 ms err: Stream isn't writeable and enableOfflineQueue options is false
  during #3: 0.1 ms err: Stream isn't writeable and enableOfflineQueue options is false
  back: first ok 469 ms after start
  commands sent during the fault ended: err, err, err

## ioredis enableOfflineQueue:false, pause
  baseline 0.6 ms ok
  during #1: 2000.4 ms no answer in 2000 ms
  during #2: 2002.2 ms no answer in 2000 ms
  during #3: 2002.3 ms no answer in 2000 ms
  back: first ok 81 ms after unpause
  commands sent during the fault ended: ok, ok, ok

## ioredis enableOfflineQueue:false, closed port
  0.3 ms err: Stream isn't writeable and enableOfflineQueue options is false
  0.0 ms err: Stream isn't writeable and enableOfflineQueue options is false

## node-redis default, kill
  baseline 1.1 ms ok
  during #1: 2001.4 ms no answer in 2000 ms
  during #2: 2002.3 ms no answer in 2000 ms
  during #3: 2000.4 ms no answer in 2000 ms
  back: first ok 923 ms after start
  commands sent during the fault ended: err, err, ok

## node-redis default, pause
  baseline 1.2 ms ok
  during #1: 2002.6 ms no answer in 2000 ms
  during #2: 2000.8 ms no answer in 2000 ms
  during #3: 2001.7 ms no answer in 2000 ms
  back: first ok 84 ms after unpause
  commands sent during the fault ended: ok, ok, ok

## node-redis default, closed port
  2001.2 ms no answer in 2000 ms
  2001.9 ms no answer in 2000 ms

## node-redis disableOfflineQueue, kill
  baseline 1.1 ms ok
  during #1: 0.0 ms err: The client is offline
  during #2: 0.1 ms err: The client is offline
  during #3: 0.1 ms err: The client is offline
  back: first ok 206 ms after start
  commands sent during the fault ended: err, err, err

## node-redis disableOfflineQueue, pause
  baseline 0.6 ms ok
  during #1: 2001.8 ms no answer in 2000 ms
  during #2: 2000.3 ms no answer in 2000 ms
  during #3: 2001.8 ms no answer in 2000 ms
  back: first ok 82 ms after unpause
  commands sent during the fault ended: ok, ok, ok

## node-redis disableOfflineQueue, closed port
  0.1 ms err: The client is offline
  0.0 ms err: The client is offline
```
