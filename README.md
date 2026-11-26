# 路由发布协调器与本地模拟转发服务

一个零运行时外部依赖的 TypeScript / Node.js 实现，用来协调跨服务的路由超时、限流配置发布。它包含：

- 发布协调器：受理发布、服务分批、批次闸门、暂停/继续、撤销、重启后对账。
- 模拟请求转发服务：持久化已接纳发布，原子切换配置，并让超时/限流真正作用于 `/proxy/:routeId` 数据面。
- 本地混沌夹具：自带示例路由数据，可控制请求不送达、请求/应答延迟、应答丢失，以及杀掉并重启服务或协调器进程。
- 操作员看板和 CLI：查看批次确认进度、撤销进度和各服务实际生效配置。
- 原子 JSON 文件持久化：临时文件 + `rename` 原子替换，服务重启或协调器离线后配置不丢。

## 1. 快速开始

要求 Node.js `>= 20`（开发验证使用 Node 22）。

```bash
npm install
npm test
```

`npm test` 会先执行 TypeScript 构建，然后启动真实的协调器、3 个服务子进程和混沌代理，运行 15 项端到端检查并输出中文可读结果。当前环境完整命令约 6–10 秒，远低于 80 秒。其中前两项专门验证启动流程：固定控制口被占用时拒绝接管并可同口重试、部分服务已启动后中断（Ctrl+C）时回收本次全部监听和子进程。

单独做类型检查/构建：

```bash
npm run build
```

## 2. 启动自带数据的本地夹具

```bash
npm run fixture -- --fresh
```

不加 `--fresh` 会继续使用 `/workspace/.runtime/local` 中上次的持久化状态；加 `--fresh` 会清空后重新播种 `fixtures/demo.json`。

### 2.1 启动就绪与故障回收

启动只在**本次**所需的协调器、服务、混沌代理和适用的控制口全部就绪后才报告成功：

- 每个本次启动的协调器和服务在 `/health` 应答中携带本次集群唯一的 `instanceId`；只有携带该 `instanceId` 的健康应答才算就绪，原有端口占用者的健康应答不会被算作本次就绪。
- 启动前会对所有固定端口（4100、4400、4201–4203、4301–4303）做预检测；端口已被占用时立即以可读错误失败，不会派生任何子进程，也不会接管或停掉占用者。
- 绑定失败、组件在超时内未就绪、或启动途中收到 Ctrl+C 时，会回收本次取得的全部监听和派生的全部子进程（包括尚未就绪的进程）；原有端口占用者保留并继续响应。故障解除后可用同一组端口直接重试。
- 启动失败后，不带 `--fresh` 重新运行即可从原入口续跑已有发布。
- `--fresh` 的新数据先写入目标目录旁的临时目录，**仅在启动成功后**通过同文件系统原子 `rename` 切换到 `.runtime/local`；启动失败时旧数据原封不动，临时目录会被清理。

固定端口如下：

| 组件 | 地址 |
| --- | --- |
| 协调器 API / 看板 | <http://127.0.0.1:4100/> |
| 夹具控制 API | <http://127.0.0.1:4400/> |
| checkout 直连 / 混沌入口 | `http://127.0.0.1:4301` / `http://127.0.0.1:4201` |
| payments 直连 / 混沌入口 | `http://127.0.0.1:4302` / `http://127.0.0.1:4202` |
| risk 直连 / 混沌入口 | `http://127.0.0.1:4303` / `http://127.0.0.1:4203` |

服务直连端口用于观察“服务实际配置”和数据面；协调器默认连接混沌入口，因此可以注入故障。

## 3. 提交发布、暂停、继续、撤销

### 3.1 用 CLI 提交示例

示例文件 `examples/batch-release.json` 包含 3 个目标服务和两个显式批次：

```bash
npm run op -- publish examples/batch-release.json
npm run op -- status batch-demo-001
```

如果重复运行，先修改示例中的 `releaseId`，或用下面的 curl 新建一个 ID。

### 3.2 用 curl 提交

单服务、单批次：

```bash
curl -X POST http://127.0.0.1:4100/api/releases \
  -H 'content-type: application/json' \
  -d '{
    "releaseId": "demo-timeout",
    "changes": [
      { "serviceId": "checkout", "routeId": "slow-quote", "timeoutMs": 40 }
    ]
  }'
```

按目标服务数量分批，每批 2 个服务：

```bash
curl -X POST http://127.0.0.1:4100/api/releases \
  -H 'content-type: application/json' \
  -d '{
    "releaseId": "demo-batch-size",
    "batchSize": 2,
    "changes": [
      { "serviceId": "checkout", "routeId": "create-order", "timeoutMs": 1010 },
      { "serviceId": "payments", "routeId": "charge-card", "timeoutMs": 1800 },
      { "serviceId": "risk", "routeId": "score-order", "rateLimitPerMinute": 240 }
    ]
  }'
```

显式指定服务批次：

```json
{
  "releaseId": "demo-manual-batches",
  "batches": [["checkout", "payments"], ["risk"]],
  "changes": []
}
```

规则：

- `changes` 非空，同一 `serviceId/routeId` 的多个配置键合并为一个对象。
- 目标服务默认取 `changes` 中出现的服务；也可用 `targetServiceIds` 显式指定，但每个目标服务必须至少有一条修改。
- `batches` 必须把所有目标服务恰好分区一次；也可用 `batchSize` 自动分批；都不传则所有目标服务在同一批。
- 当前批所有服务都被服务实际接纳并由协调器确认后，才会推进下一批。

### 3.3 暂停和继续

```bash
curl -X POST http://127.0.0.1:4100/api/releases/demo-batch-size/pause
curl -X POST http://127.0.0.1:4100/api/releases/demo-batch-size/resume
```

暂停语义：

- 协调器先进入 `pausing`。
- 已经发出的当前批会继续重试/收尾，直到整批确认。
- 当前批确认后进入 `paused`，不会启动下一批。
- `resume` 后从下一批继续。

CLI：

```bash
npm run op -- pause demo-batch-size
npm run op -- resume demo-batch-size
```

### 3.4 撤销已完成发布

```bash
curl -X POST http://127.0.0.1:4100/api/releases/demo-timeout/revoke
npm run op -- status demo-timeout
```

只有 `completed` 发布可以撤销。撤销也按批次确认；只有所有目标服务都把该发布从候选和生效配置中移除，协调器状态才变成 `revoked`。已撤销发布不会因旧 accept 请求重放而复活。

## 4. 查看进度和服务实际配置

打开看板：<http://127.0.0.1:4100/>。

或使用 CLI：

```bash
npm run op -- releases
npm run op -- status batch-demo-001
npm run op -- config checkout
npm run op -- config checkout slow-quote
```

原始 JSON：

```bash
curl -s http://127.0.0.1:4100/api/releases | jq
curl -s http://127.0.0.1:4100/api/releases/demo-timeout | jq
curl -s http://127.0.0.1:4100/api/services/checkout/actual-config | jq
curl -s http://127.0.0.1:4301/__admin/config/slow-quote | jq
curl -s http://127.0.0.1:4301/__admin/releases/demo-timeout | jq
```

协调器不可用时，仍可直接查询服务：

```bash
curl -s http://127.0.0.1:4301/__admin/config | jq
```

## 5. 验证超时和限流真的生效

`fixtures/demo.json` 中 `checkout/slow-quote` 的模拟上游延迟是 120ms，初始超时是 500ms，因此一开始返回 200：

```bash
curl -i http://127.0.0.1:4301/proxy/slow-quote
```

把超时发布为 40ms 并等待完成：

```bash
curl -X POST http://127.0.0.1:4100/api/releases \
  -H 'content-type: application/json' \
  -d '{"releaseId":"demo-504","changes":[{"serviceId":"checkout","routeId":"slow-quote","timeoutMs":40}]}'

npm run op -- status demo-504
curl -i http://127.0.0.1:4301/proxy/slow-quote
# HTTP/1.1 504 Gateway Timeout
```

限流示例：发布 `rateLimitPerMinute: 2`，重置内存计数后连续请求，可看到 `200, 200, 429`：

```bash
curl -X POST http://127.0.0.1:4100/api/releases \
  -H 'content-type: application/json' \
  -d '{"releaseId":"demo-429","changes":[{"serviceId":"checkout","routeId":"rate-limited-demo","rateLimitPerMinute":2}]}'

curl -X POST http://127.0.0.1:4301/__admin/reset-rate-limits
for i in 1 2 3; do curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4301/proxy/rate-limited-demo; done
```

## 6. 混沌夹具：送达、延迟、丢失、重启

控制 API 在 `4400`。服务名是 `checkout`、`payments`、`risk`。

### 6.1 条件规则

规则可按方法和路径中的发布 ID 匹配，`times` 表示只作用于前 N 个匹配请求；省略 `times` 则一直有效。

请求根本不转发到服务：

```bash
curl -X POST http://127.0.0.1:4400/chaos/payments/rules \
  -H 'content-type: application/json' \
  -d '{
    "match": { "method": "POST", "pathIncludes": "my-release" },
    "dropRequest": true
  }'
```

请求送达、服务也处理，但应答丢失：

```bash
curl -X POST http://127.0.0.1:4400/chaos/checkout/rules \
  -H 'content-type: application/json' \
  -d '{
    "match": { "method": "POST", "pathIncludes": "my-release/accept" },
    "dropResponse": true
  }'
```

延迟请求或应答：

```bash
curl -X POST http://127.0.0.1:4400/chaos/checkout/rules \
  -H 'content-type: application/json' \
  -d '{
    "match": { "pathIncludes": "my-release" },
    "delayRequestMs": 200,
    "delayResponseMs": 800,
    "times": 1
  }'
```

清除某服务的全部规则、全局策略和请求记录：

```bash
curl -X POST http://127.0.0.1:4400/chaos/checkout/reset
```

也可以设置/替换全局策略：

```bash
curl -X POST http://127.0.0.1:4400/chaos/checkout/global \
  -H 'content-type: application/json' \
  -d '{"delayResponseMs":300}'
```

### 6.2 杀掉并重启真实进程

重启某个服务（PID 会变化，持久化配置保留）：

```bash
curl -X POST http://127.0.0.1:4400/restart/checkout
curl -s http://127.0.0.1:4301/health
```

重启协调器：

```bash
curl -X POST http://127.0.0.1:4400/coordinator/restart
```

查看夹具进程和混沌规则：

```bash
curl -s http://127.0.0.1:4400/state | jq
```

### 6.3 推荐手工故障演练

1. 创建一个两批发布，例如 `examples/batch-release.json`。
2. 在第二批服务上设置 `dropRequest`，观察第一批确认、第二批 pending，且第三批/后续批不发出。
3. 调用 pause；清除故障后，当前批收尾并进入 `paused`。
4. resume，观察后续批次完成。
5. 对发布 A 设置 `dropResponse`，确认服务直连 API 已显示 active，但协调器未确认。
6. 再创建并完成同路由的发布 B；B 可以正常生效和确认。
7. 清除 A 的故障，A 被幂等重送/对账；由于 A 的协调器受理顺序更早，B 仍是赢家。
8. 撤销 B，配置回退到 A；撤销 A，配置回退到服务初始值。
9. 完成一个发布后停止协调器，再重启服务进程；直连服务配置不变。
10. 重启协调器，它会从持久化状态恢复，并查询服务实际 release 状态继续未完成发布或撤销。

## 7. 持久化文件

手动夹具默认写入：

```text
.runtime/local/
├── cluster-config.json
├── coordinator-state.json
└── services/
    ├── checkout.json
    ├── payments.json
    └── risk.json
```

自检使用系统临时目录，并在启动输出中打印本次目录。

写入使用同目录临时文件 + `rename`：

- 读方要么看到旧完整快照，要么看到新完整快照。
- 服务接纳/撤销一组修改时，候选索引、release 记录、物化 `effective` 和幂等响应在同一次状态替换中生效。
- 协调器重启后从 `coordinator-state.json` 恢复发布状态、批次索引和幂等键。
- 服务重启后从自己的 JSON 文件恢复，不依赖协调器在线。

## 8. 关键规则如何实现

### 配置优先级

每个服务持久化：

- `routes[routeId].initial`：该服务自己的初始值。
- `routes[routeId].effective`：当前物化生效值，读取单路由时直接取，复杂度 O(1)，不扫描发布历史。
- `candidates[routeId][configKey]`：该配置项的已接纳候选，按 `coordinatorAcceptedAt + acceptedOrder` 新旧排序。
- `releases[releaseId]`：本服务已接纳或已撤销的整组修改。

取值规则：

1. 只考虑本服务状态为 `active`（已接纳且未撤销）的发布。
2. 取协调器受理时间最晚、并以单调 `acceptedOrder` 打破同毫秒/时钟并列的候选。
3. 没有候选时使用 `initial`。
4. 服务自己的接纳时间只记录何时开始参与，不参与优先级排序。

撤销当前赢家时，会从对应配置键候选栈移除该发布，并把 `effective` 重算为下一候选或初始值。

### 增量下发

协调器只把某个服务在该发布中的 `changes.filter(serviceId === 当前服务)` 放进 accept 请求；不会发送其他服务或该服务的无关路由。撤销请求只带 release ID 和固定幂等键，请求体为 `{}`。

自检会解析混沌代理记录的请求体，并断言：

- 只包含目标少数路由；
- 不包含大量无关路由 ID；
- 单路由 accept 请求小于该服务全量配置响应的一半；
- revoke 请求体保持常量大小。

### 幂等重送

每个“发布 × 服务 × 动作”使用稳定的 `Idempotency-Key`：

```text
accept:<releaseId>:<serviceId>:v1
revoke:<releaseId>:<serviceId>:v1
```

服务把首次响应和状态在同一原子文件事务中保存。重送相同键直接返回首次响应，并带 `x-idempotent-replay: true`，不会重复加入候选。即使原 accept 成功应答丢失、之后该发布又被撤销，重放旧 accept 键也只返回旧响应，不会让已撤销发布复活。

### 对账

协调器周期性以及在重启时：

- 对运行中/暂停收尾中的当前批调用服务 `GET /__admin/releases/:id`。
- 服务返回 `active` 就标记接纳确认。
- 撤销中则寻找 `revoked` 或 `404 absent`。
- 然后继续对应批次状态机。

因此协调器可以在应答丢失、进程重启或通信恢复后，以服务实际持久化状态为准继续。

## 9. HTTP API 摘要

协调器：

```text
GET  /health
GET  /                                  # HTML 看板
GET  /api/releases
POST /api/releases
GET  /api/releases/:id
POST /api/releases/:id/pause
POST /api/releases/:id/resume
POST /api/releases/:id/revoke
POST /api/releases/:id/reconcile
POST /api/reconcile
GET  /api/dashboard
GET  /api/services/:serviceId/actual-config
```

服务：

```text
GET  /health
GET  /__admin/config
GET  /__admin/config/:routeId
GET  /__admin/releases/:releaseId
GET  /__admin/state
POST /__admin/releases/:releaseId/accept
POST /__admin/releases/:releaseId/revoke
POST /__admin/reset-rate-limits
GET  /proxy/:routeId[/...]
GET  /__upstream/:routeId
```

夹具控制：

```text
GET  :4400/
GET  :4400/state
POST :4400/chaos/:serviceId/global
POST :4400/chaos/:serviceId/rules
POST :4400/chaos/:serviceId/reset
POST :4400/restart/:serviceId
POST :4400/coordinator/restart
```

## 10. 目录结构

```text
fixtures/demo.json              自带服务、路由、初始值和模拟上游数据
examples/batch-release.json     显式批次发布示例
src/shared/                     类型、校验、原子存储、HTTP 工具
src/service/                    配置核心、转发/限流/超时 HTTP 服务、进程入口
src/coordinator/                发布状态机、对账、API/看板、进程入口
src/chaos/proxy.ts              可编排请求/应答故障的代理
src/fixture/cluster.ts          真实子进程集群和重启控制
src/fixture/local.ts            npm run fixture 与 :4400 控制 API
src/cli/operator.ts             npm run op 命令行
src/test/run-checks.ts          npm test 端到端自检
```
