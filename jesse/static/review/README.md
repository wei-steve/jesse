# Jesse 多周期复盘扩展页

原型入口：`/review/index.html?session=<backtest UUID>`。在与 Jesse 相同的 origin（包括 hostname 和端口）登录后使用。页面读取现有认证的 session/chart-data POST 接口，不创建回测、不下单、不修改策略或结果。

这是独立的静态扩展页，原 dashboard 的 Trade Chart 和菜单未修改。没有 dashboard-v1 源码时，不应逆向修改压缩的 Vue bundle。后续可以把此页入口接入源码中的回测结果组件。

## 使用

- **选择回测**：页面顶部“选择回测”展开列表（`POST /backtest/sessions`，每次 100 个，“加载更多”继续，按最近更新排序）。每项显示：标题（没有标题时用第一条路由的策略名）、回测区间、状态、净收益（`net_profit_percentage`，已是百分数）；列表接口目前没有交易笔数字段，所以不显示，接口以后提供 `trade_count` 才会出现。只有 `finished` 能点，其他状态置灰。搜索框按标题搜索（接口 `title_search`，停止输入 0.3 秒后或按回车）。选中后用 `history.pushState` 更新网址 `?session=`，浏览器后退/前进回到上一个回测；切换时保留显示设置（周期、指标、副图开关）、窗口长度、排序和“显示全部成交”，清空所选交易、时间窗口、路由。网址没有 `?session=` 时不报错，直接展开列表；`?session=` 无效时提示并展开列表。数据整理在 `sessions.mjs`（纯函数，`tests/review-sessions.test.mjs`）。
- 左侧交易下方写“入场时间 · 持仓 N 分钟”，超过 60 分钟写“X 小时 Y 分钟”；持仓时长是入场到离场的时间。
- 需要保存了图表数据的 **1m 交易路由**。
- 左侧选择交易，各周期图一起定位到入场；使用“定位离场”“上一笔”“下一笔”逐笔检查。
- “周期与指标”面板：从 1m–1D 中勾选任意多个显示周期，至少 1 个（默认显示策略配置的全部周期，标“策略”）；添加、编辑、移除指标。主图叠加 SMA / EMA / 布林带，附图显示 RSI / MACD / ATR / 成交量，每个附图指标一个独立小图，与主图时间轴对齐联动。最多 10 个指标，设置保存在当前浏览器（`jesse.review.display.v1`），改设置时不重新读取数据，保持当前交易和时间窗口。
- **MA 均线组**（默认显示设置）：一个指标含 12 条均线，每条可勾选、自定义周期（1–5000 整数）和颜色，整组共用一个 SMA/EMA 选项。默认周期 5、7、10、14、20、30、50、60、100、120、150、200，默认勾选 5、7、10、20、30，12 条默认颜色各不相同。只计算和绘制勾选的线；卡片标题整组一个标签（如 `MA(5,7,10,20,30)`，每个周期前有对应颜色的小色块，标签过多时换行），图例和十字线数值只列勾选的线并带色块。设置面板选择“MA 均线组”后显示 12 行（勾选 + 周期 + 颜色），编辑时回填当前值，至少勾选 1 条。算法与单条 SMA/EMA 完全相同。旧的单条 SMA / EMA 仍可添加，已保存的旧设置照常恢复；不合法的保存设置回退为默认的 MA 均线组。已保存过旧默认（单条 SMA5）的浏览器会继续显示原设置，需要时自行添加 MA 均线组。
- 工具栏“显示副图”是所有周期副图的总开关：关闭后不计算也不绘制附图指标，主图叠加指标不受影响；开关状态随显示设置保存，切换时保持当前交易和时间窗口。
- 指标按各周期自己的 K 线计算，参数单位是该周期的根数。图例默认显示入场时最后一根已收盘 K 线的指标值，鼠标悬停时显示所指 K 线的值。
- 卡片顶部的“策略参考 SMA5”与显示设置无关，蓝框标出入场前最近记录的 MA5 context 周期。
- 拖动、滚轮缩放一个图时，其余图跟随时间范围；十字线定位到同一时刻所在的各周期 K 线。
- 6/12/24 小时窗口可以切换；显示全部成交默认关闭，避免标记重叠。
- 所有时间是 UTC，区别于原 dashboard 可能显示的本地时间。盈亏显示保存的 USDT 净盈亏，不显示杠杆保证金 ROI。

## 数据边界

- 指标口径与 Jesse 3.5 自带指标一致（`tests/fixtures/review-indicators-jesse.json` 与 `jesse.indicators` 逐值相同）：EMA 从第一根收盘价开始；RSI、ATR 用 Wilder 平滑；布林带用总体标准差；MACD 柱 = DIF − DEA（不乘 2）；无下跌时 RSI 为 100。
- 回测图表没有导出 warmup 历史，所以开头的指标值不可用或不可靠（例如 EMA/MACD 在第一根 K 线处为起始值）。高周期 K 线少于指标所需根数时，附图显示“数据不足”。

- 保存的 1m OHLCV 按 UTC 边界合成 3m/5m/15m；缺失分钟及不完整桶不合成。没有访问交易所重新下载数据。
- 图是事后复盘，显示入场后的完整历史。每图的“入场时最后已收盘”独立按 `open_time + interval <= entry_time` 计算，不使用形成中的高周期最终收盘价。
- 入场、离场标记和蓝色竖线落到事件所在周期 K 线。不同周期时间端点按各自 K 线取整，最多相差一根高周期 K 线，不保证像素级完全对齐。
- 图表没有导出 warmup 历史，因此开头不足 5 根的 SMA5 不可用，不能据此认为原策略缺少 warmup。
- `MA5 context / Selected minutes` 来自该策略保存的图表点。点在 1m 结束后才可用；所显示的是入场/订单创建前最近记录，不能当成完整的原始触发信号重放。
- 采用实际 EXECUTED 订单画标记，不用交易均价伪造单次成交；缺少订单记录时不生成标记。
- minute OHLC 及回测成交时间不能证明分钟内的撮合先后、排队或滑点。

## 指标数值开关

- 工具栏“显示指标数值”（在“显示副图”左边），**默认关**。关时隐藏每张图上方的“入场时最后已收盘”摘要和图例，只留卡片标题和指标标签（附图自己的标题行不受影响）；开时恢复原样。状态随显示设置保存（`showValues`，旧数据缺省为关）。切换只改 `#charts` 的 CSS class `hide-values`，不重建图表，不改交易和时间窗口。
- 鼠标悬停在图上不再弹出数值窗口（会挡住 K 线）。查看数值请打开“显示指标数值”：开关打开后，图上方显示摘要和图例，图例随鼠标悬停的 K 线更新。

## 更新后让浏览器用新版本（缓存）

Jesse 的静态服务没有 `Cache-Control`，浏览器会按启发式缓存 `.mjs` 和 CSS，旧脚本可能一直用到被强制刷新。解决办法是给所有文件加版本号查询参数，版本号一变，浏览器就把它当新地址：

- `index.html` 里的内联加载器用 `const REVIEW_VERSION = '…'` 动态 `import(`./app.mjs?v=${REVIEW_VERSION}`)`，样式表是 `review.css?v=…`。`index.html` 本身是页面请求，普通刷新会重新校验。（`finder.html`、`market.html` 同样。）
- 每个 `.mjs` 里的相对 import 都写成 `'./xxx.mjs?v=…'`（同一个版本号，包括图表库 `./lightweight-charts.mjs?v=…`）。

**以后改了 `jesse/static/review/` 里任何文件（`.mjs`、`.css`、`index.html`），提交前必须换版本号：**

1. 选一个新版本号，建议日期加字母，如 `20261113i`（同一天再改就 `b`）。
2. 把 `index.html`、`finder.html` 和 `market.html` 里的 `REVIEW_VERSION`、`review.css?v=` 和所有 `.mjs` 文件里 `?v=` 后面的旧版本号全部替换成新的（可用 `grep -rn "?v=" jesse/static/review/` 找，或全局替换旧版本号字符串）。
3. 新增模块时，import 也要写成带同一个 `?v=` 的形式。
4. 运行 `node --test tests/review-*.test.mjs`。`tests/review-version.test.mjs` 会检查 `index.html`、`finder.html`、`market.html` 和所有 import 的版本号一致，漏改会报错（它不能检查你“有没有换新版本号”，所以第 1 步要自己记得）。
5. 用户普通刷新（Cmd+R）即可拿到新版本。

## 测试与安装

从 Jesse 仓库根目录执行（不需要新依赖）：

```sh
node --test tests/review-*.test.mjs
for f in jesse/static/review/*.mjs; do node --check "$f"; done
```

源码安装（`pip install -e .`）时，`jesse run` 直接从本仓库的 `jesse/static` 读取这些文件，改完刷新页面即可，无需复制或重启。

若仍使用官方 Docker 镜像，需要把目录复制进容器（重建容器后会丢失，需重新复制）：

```sh
docker cp jesse/static/review jesse:/jesse-docker/jesse/static/
```

图表库 Lightweight Charts v4 已复制到本目录 `lightweight-charts.mjs`（`t` 为 createChart，不访问 CDN）。它原本是 dashboard 打包的 chunk `../_nuxt/eDEyLi0S.js`；Jesse 3.6.1 重新打包后该 chunk 消失，页面因此打不开，所以改为自带一份，升级 Jesse 不再影响复盘页和因子查找器。

回滚时移除 `review` 目录即可，原 dashboard、后端及数据库未修改。

## 入场 / 离场条件

- 选中交易后，交易信息区下方显示“入场 / 离场条件”，“收起/展开”按钮的状态随显示设置保存（`showConditions`，旧数据缺省展开）。
- 数据来自策略写入的 `chart_data.strategy_charts.extra_charts.trade_info`（格式见项目仓库 `tasks/T-13-trade-info-contract.md`）。图表点的 time 是 1m K 线开盘时间，交易 `opened_at` / `closed_at` 是收盘时间，所以按“点 time = opened_at/1000 − 60（离场用 closed_at）”整数秒精确匹配，找不到再试同一 UTC 分钟；没写的字段不显示。解析与文字在 `tradeinfo.mjs`（纯函数，`tests/review-tradeinfo.test.mjs`）。
- 有入场记录时，顶部“入场前最近记录的周期”显示如“15m 判断 · 3m 入场 · SMA20”，入场周期那张图高亮；没有 `trade_info`（V1、旧回测）时保持 MA5 context 的原逻辑，条件区显示“此回测没有记录入场/离场条件”。

## 信号模式

回测的 `chart_data.strategy_charts.extra_charts` 里有 `ride` 时自动进入信号模式（用于“不交易、只写信号”的辅助回测，0 笔交易也能打开）。没有 `ride` 的普通回测完全不变。页面只认下面的通用格式，不含任何具体规则（逻辑在 `rides.mjs`，纯函数，`tests/review-rides.test.mjs`，夹具 `tests/fixtures/review-ride-extra-charts.json` 是真实信号回测的前 3 天）。

**数据格式**
- `ride`：每个周期一个 series，title 为 `1h`/`15m`/`5m`/`3m` 等（按 title 解析分钟数，支持 m/h/d/w，不写死周期）。`data` 是 `{time, value}` 阶梯序列：只在值变化时写点，值保持到下一个点，最后一个点保持到回测结束。`time` 是 1m K 线开盘时间（秒），该值在 time+60 收盘时已知。`value` = +N 沿 SMA N 上涨，−N 沿 SMA N 下跌，0 无。
- `ride_touches`：同样的 title 和时间点，值为回踩次数，只用于显示（取区间内最大值）。

**区间合并规则**（每个周期独立）：连续同方向的非 0 值合成一个区间；区间中途换均线周期不拆开，按顺序记下用过的周期（如 `MA10→MA20`）；区间 = [开始 time, 下一个值为 0 或反向的点的 time)，反向时同一个点既结束旧区间又开始新区间；到回测结束仍未变化的区间结束于最后一根 1m K 线收盘（列表标“到回测结束”）。持续根数 = 区间秒数 ÷ 周期秒数，四舍五入，至少 1。

**显示**
- 左侧列表替代交易列表：周期、↑绿/↓红、均线、开始时间（UTC）、持续根数；可按周期勾选过滤（默认全选），按开始时间排序，工具栏“上一个/下一个”按过滤后的列表翻（当前项被过滤掉时取时间上最近的）。点击区间，各周期图一起定位到区间开始，区间所在周期的图高亮。
- 每张周期图只画本周期的区间：区间第一根 K 线的**下一根**上一个标记（`MA10↑` 绿箭头在下，`MA10↓` 红箭头在上）：信号要等第一根收盘才知道，最早只能在下一根开盘入场，所以箭头画在入场那根上；第一根就是最后一根 K 线时还没有下一根，箭头留在它上面并写“（下根入场）”。左侧列表和信息栏的时间也是这个入场时间。箭头只说明“哪根入场”，不代表价格好坏，所以每个信号还画一小段深色横线标出**入场价（入场那根的开盘价）**，从信号那根画到入场后一根；在左侧列表选中一个信号时，它所在周期的图上再画一条带“入场”价格标签的虚线，信息栏写出入场价；区间内把所骑的均线（该周期 K 线上的 SMA N，N 随区间里的值变化）画成粗线。每个区间是单独的一条线（图表库会把同一条线上相邻的点连起来，空白点也不能断开，所以区间之间不能共用一条线），区间之间一定断开。落点：值在 time+60 已知，对应收盘时间 ≤ time+60 的最后一根该周期 K 线；已结束的区间画到“收盘时间 ≤ 结束点 time+60 的那根”之前。均线预热不足的 K 线不画。
- 顶部状态条：当前时刻各周期状态，如 `1h ↑MA20 · 15m — · 5m ↑MA10 · 3m ↑MA5`，第二行写出各自是哪个周期，如 `1h、5m 向上 → 不宜做空；3m 向下 → 不宜做多`（只有一个方向就只写一段，都没有就不写）。选中区间时是区间开始时刻；鼠标在图上移动时是所指 K 线收盘时已知的状态，移开后回到选中区间。
- 信号模式下隐藏“定位入场/离场”“显示全部成交”和交易排序；列表使用 `content-visibility:auto`，几百上千个区间也不卡。

## 因子查找器

入口 `/review/finder.html`（复盘页顶部“因子查找器”，查找器顶部“← 返回复盘页”）。不依赖回测：直接从数据库读 1m K 线、合成各周期、运行项目里的因子文件、画图，所以能看到今天到最新一分钟的行情，也不创建任何回测。流程：改 `factors/<name>.py` → 页面点“查找”（每次都重新加载文件，不用重启服务）。框架里没有任何具体规则，只有下面的约定。

**因子文件**（项目目录，即 `jesse run` 的 cwd，下的 `factors/<name>.py`，`<name>` 只能是 `^[A-Za-z0-9_]+$`，不能以下划线开头）：

```python
TITLE = '...'            # 页面下拉框显示
VERSION = 'v1'           # 页面显示，用于对照
DESCRIPTION = '...'      # 可选，页面上的一段说明
TIMEFRAMES = ['1h', '15m', '5m', '3m']   # 默认勾选的周期
PARAMS = [{'name': 'window', 'label': '最近几根', 'default': 8, 'min': 3, 'max': 50, 'step': 1}]
WARMUP_BARS = 45         # 每个周期在显示范围之前需要的历史根数
def compute(candles_by_tf: dict, params: dict) -> dict:
    # candles_by_tf[tf]: Jesse 格式 ndarray (timestamp ms, open, close, high, low, volume)，已收盘的完整 K 线，含 warmup
    # 返回 {tf: {'value': 每根一个数, 'touches': 每根一个数(可选), 'label': 可选}}，长度与该周期 K 线相同
    # value: +N = 沿 SMA N 向上，-N = 沿 SMA N 向下，0 = 无。第 i 根只能用第 0..i 根（不看未来）
```

- 加载：服务端把 cwd 放进 `sys.path`，每次请求前清掉 `sys.modules` 里的 `factors` 包再 `import_module('factors.<name>')`（因子文件和它 import 的辅助模块都是新的）。名字不合法或文件不存在返回 400；不执行请求里的任何代码。注意 `.pyc` 按修改时间（秒）判断，同一秒内改了文件且长度不变时可能读到旧缓存，正常手工修改不会遇到。
- `params` 只接受 PARAMS 里声明过的名字（别的名字 400）；缺的用 default；数字超出 min/max 时截断；default 是整数的参数取整；不是数字 400。
- `compute` 抛异常、返回格式或长度不对：400，`error` 里带异常的最后一行（页面状态区原样显示）。
- 页面把 `value` 变化转成与信号模式同样的阶梯序列：第 i 根的值在该根收盘时已知（落在该根最后一根 1m 的时间点）。所以区间合并、落点、状态条、上一个/下一个与信号模式完全相同（`rides.mjs`；转换在 `finder-data.mjs` 的 `rideExtra`）。

**接口**（都是 POST，需要登录 token；实现在 `jesse/controllers/factors_controller.py` 和 `jesse/services/factor_finder.py`）

- `POST /factors/list` → `[{name, title, version, description, timeframes, params}]`；`factors/` 不存在时返回 `[]`；某个文件导入失败时该项带 `error`，不影响其他因子。
- `POST /factors/run` `{factor, exchange, symbol, start, finish?, timeframes, params}`
  - `start`/`finish`：UTC，ISO 字符串（没写时区按 UTC）或毫秒数；取整到分钟；包含开盘时间在 [start, finish] 内的 1m K 线。`finish` 省略 = 数据库里该品种最新一根 1m。范围不按天数限制，按一次返回的 K 线总根数限制：各所选周期合计不超过 60 万根（约 45 MB；例如 1h/15m/5m/3m 一起约 1.8 年，只选 1h/15m 可以查全部历史），超过返回 400 并提示缩短范围或去掉小周期；`finish` 不晚于 `start` 也是 400；范围内没有 K 线 404。
  - 不用 `get_candles_from_db`（它把起止取整到整天，会丢掉今天），用 `_get_candles_from_db` 按精确时间读 1m，自己合成 3m/5m/15m/1h…（支持到 1D；周和月没有干净的对齐方式，不提供）。**只保留完整的 K 线**：桶里缺任何一根 1m、或还没走完（最后一根未收盘的高周期 K 线）都不要，与复盘页口径一致。
  - 每个周期往前多取 `WARMUP_BARS` 根给 `compute`，返回前去掉；开盘时间早于 `start` 的 K 线算 warmup。
  - 返回 `{factor, title, version, exchange, symbol, params（实际使用的）, start, finish, last_candle_time, timeframes: {tf: {candles: [{time,open,high,low,close,volume}], value: [...], touches: [...], label?}}}`，时间全是 UTC 秒；`candles`、`value`、`touches` 一一对应；`last_candle_time` 是读到的最后一根 1m 的开盘时间。

**页面**
- 顶部表单：交易所（默认 Binance Perpetual Futures）、品种（默认 BTC-USDT）、范围（最近 1/3/7/14/30/90/180/365 天到最新，默认 7 天；或自定义 UTC 起止，结束留空 = 最新）、因子下拉框（TITLE + VERSION）、PARAMS 输入框（超出范围自动截回）、周期勾选（默认因子的 TIMEFRAMES）。表单内容保存在浏览器（`jesse.finder.form.v1`），下次打开恢复，打开页面和点“查找”都会重新读取最新数据。
- “更新到最新”：调 `POST /candles/import`（start_date = 昨天 UTC，库里最新 K 线更早时从那天起，不留缺口），每 2 秒轮询 `/candles/import-status`，完成后自动再查找；失败时显示错误。顶部写“数据到 xx:xx UTC”，数据落后超过 10 分钟时提示。
- **“实时（每分钟）”**（“更新到最新”旁的复选框）：勾上后每到 UTC 整分钟后约 5 秒跑一轮——`POST /candles/import`（start_date = 昨天 UTC）→ 等导入完成 → 用当前表单重新 `POST /factors/run` → 原地更新。时间算的是“离下一个整分 +5 秒还有多少毫秒”（`finder-data.mjs` 的 `nextTickDelay`），不是固定 60 秒的 `setInterval`，所以不会漂移；勾选状态存在表单里（`jesse.finder.form.v1` 的 `live`），刷新页面后继续。自定义范围填了“结束”时不能开：勾上会提示“实时需要把结束留空”并取消勾选。
  - 一轮还没跑完就跳过这一分钟；页面在后台（`document.hidden`）时暂停，切回前台立刻补一次；主人正在写备注（信号备注框 / K 线备注框打开，或焦点在任意 input / select 里）时，这一轮只拉数据和查找、不重画，等输入框关掉再画。
  - 导入或查找失败：状态栏显示错误，下一分钟继续试；连续 3 次失败自动关掉“实时”并提示。上次的导入超过约 90 秒没完成就取消这一次（数据落后 2 小时以上时是在补数据，放宽到 30 分钟）（`/candles/cancel-import`），不会每分钟堆一个。
  - 手动点“查找” / “更新到最新”时实时让路（`manualBusy`），再加上 `runVersion`，旧结果不会盖掉新结果。
  - **更新不打断看图**：不重建页面，按 `ride.key` 找回选中的信号（找不回来就保持不选，不跳到别的信号）；每张图的可见范围读出来再放回去——右边缘原本贴着最新 K 线的跟着最新走（缩放不变），拖到历史位置的保持不动；列表滚动位置、已渲染的条数、周期过滤、标注过滤、已加载的标注和 K 线备注都保留。不弹“正在查找…”，只在右上角写“实时 · 最后更新 hh:mm:ss UTC”。
  - 上一轮没有的信号（新 `ride.key`）：列表里那一项高亮 3 秒（CSS 动画），状态栏写“新信号：3m ↓ MA5 09:30”；不发声音。
  - **正在形成的那根 K 线**（`live-price.mjs` 的 K 线推送）：实时开着时，浏览器另开一条币安公开 K 线组合推送（永续 `wss://fstream.binance.com/market/stream?streams=<币对>@kline_3m/<币对>@kline_1h/…`，现货 `stream.binance.com:9443/stream?streams=…`；只订阅当前勾选、并且币安有推送的周期：1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1D，别的周期不画），把每个周期正在形成的那根画在该图最右边，随成交实时跳动（普通涨跌色，`series.update()`）。叠加的复盘页指标（MA 均线组 / SMA / EMA / BOLL）的最后一点也跟着变：每张图最多每 500ms 用“最近 max(周期)*3+50 根已收盘 + 形成中这根”重算一次（`indicators.mjs` 的 `formingTail` 与 `tailBars`），不动整段历史；SMA / BOLL 的末点与整段计算完全相同，EMA / RSI / ATR 这类递归指标从窗口起点重新起算，属于近似。**它只用于显示**：不进 `panel.candles`，不产生信号标记、不参与挂单模拟和统计，十字线 / 状态条仍按已收盘 K 线判断。形成中那根换成下一根（新的开盘时间）时，前一根留在图上并记进 `streamBars`（指标末点也按它先定稿），直到下一分钟的实时导入用 `setData` 把它变成正式已收盘 K 线（`updatePanel` 之后再把当前的 forming 补回去）。关掉“实时”就断开 K 线连接、`setData` 回已收盘数据（指标线一起回去）；换币种 / 交易所 / 勾选周期会重新订阅；断线重连与价格线同一套规则（1、2、4… 最多 30 秒；20 秒没消息也重连）；页面在后台时连接保持（数据量很小）。图贴在右边缘时窗口跟着形成中的 K 线右移，关掉“实时”再移回来。
  - 信号、挂单、标注和统计的口径没变：只用已收盘的完整 K 线，最后一根未收盘的高周期 K 线不进数据（实时开着时最右边会多出上面那根只用于显示的形成中 K 线，关掉就没有）。
  - **实时价格线**（`live-price.mjs`）：实时开着时，浏览器直接连交易所公开成交推送（Binance 永续 `wss://fstream.binance.com/market/ws/<币对>@aggTrade`，现货 `stream.binance.com:9443/ws/...`；不用密钥、只发币对名），每 250 毫秒把最新成交价画成每张图上一条浅红色细虚线，轴上标“实时”。只是一条价格线，不改 K 线数据、不改信号（形成中的那根 K 线是另一条推送，见上一条）。断线按 1、2、4… 最多 30 秒重连；连上但 20 秒没消息也重连。其他交易所没有推送时右上角写“这个交易所没有实时价格”。
  - 纯函数 `nextTickDelay`（下一次触发的毫秒数）、`newKeys`（新信号 diff）、`atRightEdge` / `shiftRange`（是否贴右边缘、跟随平移）在 `finder-data.mjs`，测试在 `tests/review-finder-data.test.mjs`。
- 结果：左侧区间列表（周期、↑/↓、均线、开始时间、根数；按周期过滤，上一个/下一个），点击后各周期图一起定位；图默认只画 K 线和所骑的均线（粗线，区间之间断开，起点标记 `MA10↑`）。勾选“叠加复盘页的显示设置”后把复盘页保存的主图指标（MA 均线组、SMA、EMA、布林带）叠上来。
- **挂单**（表单里“挂单”那一行）：把“信号之后怎么入场”做成可选算法，默认 `open`（下一根开盘，即原来的入场价），另有 `close`（信号 K 线收盘价）、`close_atr`（收盘价往回让 x·ATR，做多减、做空加）、`mid`（信号 K 线中点）、`retrace`（回撤 y 倍振幅）、`sma5` / `sma10`（SMA 的斜率预估值 `ma[j] + (ma[j]−ma[j−1])`）。x、y、止损 ATR 倍数 k（默认 1）、止盈 R（默认 2）、最多持有根数（默认 48）随表单一起保存在 `jesse.finder.form.v1`。**挂单不只等下一根**：挂出后每根 K 线收盘都按同一算法用刚收盘的那根重算一次挂单价（SMA5 规则就是跟着 MA5 预估走），这个价对下一根有效，一直挂到趋势标记失效那根为止（趋势还在走就一直挂到数据末尾）。图上画成阶梯线：每根一个水平段，从信号那根画到成交那根，之后入场价水平线到离场；没成交的灰色阶梯线画到撤单那根，还在等的灰色虚线画到最后一根。成交处一个箭头小标记，离场处一个圆点并写 `+1.9R` / `-1.0R`。选中信号时信息栏写“第 n 根成交，挂单价 X”/“趋势结束仍没成交（等了 n 根）”/“等待成交（已等 n 根）”，开盘就越过挂单价的根数单列（`开盘越过 m 根`），成交的再写止损、止盈、结果 R 和离场原因。条件说明下面的“挂单”汇总按周期写标记数、成交率（成交 /（标记数 − 等待中））、等待中数、胜率、平均 R、合计 R（胜率与 R 只用走完的成交单）。
- 状态条与“最新”视图：查找完成后默认定位到最后一根，状态条写此刻各周期状态和各周期的建议（`1h ↑MA20 · 15m — · …` / `1h、5m 向上 → 不宜做空；3m 向下 → 不宜做多`，都没有就写“各周期都没有沿均线走”）；“跳到最新”随时回到这里；点区间或鼠标移到图上时状态条跟着变。
- 区间从所选范围的起点开始算（范围之前已经开始的区间被截断）；画均线用范围内的 K 线计算，均线周期大于范围内已有 K 线根数时起点附近画不出线。
- 挂单的成交与结果判定（每根挂单价只对下一根有效：开盘越过挂单价算这一次不成交、`gapBars` 计数并继续等下一根，最低/最高价越过挂单价算成交；止损 = 挂单价 ∓ k·ATR（用算出这个挂单价那根的 ATR），止盈 = 挂单价 ± r·(k·ATR)；成交那根只查止损，同一根两碰按止损，超过持有根数按收盘平；`open` 规则照旧下一根开盘成交）在 `limit-rules.mjs`（纯函数，`tests/review-limit-rules.test.mjs`），ATR(14) 用 Wilder 平滑，与复盘页附图口径一致。
- 测试：`tests/test_factor_finder.py`（后端，用示例因子和造的 K 线）、`tests/review-finder-data.test.mjs`（表单、请求、阶梯序列转换）、`tests/review-live-kline.test.mjs`（K 线组合流 URL、不支持的周期过滤、K 线消息解析、形成中那根的指标末点与整段计算结果对照）。

## 看行情页

入口 `/review/market.html`（复盘页顶部「看行情」、因子查找器右上「看行情」；本页右上「因子查找器」「复盘页」）。一个干净的看盘页，像行情软件：选数据源和品种、多周期 K 线同屏、实时跳动或轮询刷新、指标跟着变，没有信号、挂单、标注和回测内容。

- **四个数据源**（顶部「数据源」下拉，存 localStorage `jesse.market.source.v1`）：**Binance**（默认）、**OKX**、**Deepcoin**、**美债收益率**。T-54 起「合约 / 现货」不再是数据源，而是左栏产品列表里的子标签；旧值 `binance-perp` / `binance-spot` 自动迁移成 Binance + 合约 / 现货。切换时先用一个很轻的请求探一下新品种，失败就报中文错误并保留当前图表（不会白屏，也不会让下拉和图表对不上）。
- **左栏三个标签**：「自选」、「<当前数据源名>」（如「Binance」「美债收益率」）和「备注」（T-56），点哪个显示哪个，记在 localStorage `jesse.market.asidetab.v1`；切换数据源时第二个标签名跟着变。第二个标签下是「合约 | 现货」子标签（美债没有，只有六行 US03M…US30Y）、一个搜索框（输 `sol` 在全量里过滤）和该数据源的全部 USDT 产品：按 24 小时成交额从大到小排（Binance 用 `quoteVolume`，OKX / Deepcoin 用 `volCcy24h`），每行显示名称、最新价、24 小时涨跌幅，右边的 ☆ / ★ 一键加入 / 移出自选，点行切换图表。可能上千行，所以先画 200 行 + 「显示更多」（`PRODUCT_PAGE`），搜索在全量里搜。列表报价每 10 秒刷新一次（打开该标签时才刷新），不按产品开 socket；子标签的选择存在 `jesse.market.listmarket.v1`。
- **K 线备注（T-56，与因子查找器同一套）**：双击任意 K 线（含最右边那根正在形成的）→ 该卡片顶部弹出输入框，标题如「10-27 08:36 UTC · 3m 这根 K 线的看法」，已有备注就预填；回车 / Ctrl+Enter 保存，空着回车删除，Esc 取消。备注框、key、紫色「注」标记和快照都来自共用模块 `bar-notes.mjs`，所以两页行为完全一致（因子查找器也改用它）。存进当前备注本（默认 `storage/labels/finder-labels.jsonl`，一行 `kind=bar`，`key` = `bar|exchange|symbol|tf|time`），exchange / symbol 用因子查找器的写法：`Binance Perpetual Futures` / `Binance Spot`、`OKX Perpetual` / `OKX Spot`、`Deepcoin Perpetual` / `Deepcoin Spot`、`US Treasury Yields`（symbol 都是 `BTC-USDT`，美债是 `US02Y` 等），所以同一根 K 线在两个页面共享同一条备注。`bar` 快照同查找器（o/h/l/c、MA5、MA10、ATR、BOLL），美债的指标按「交易时段连续」口径算（`sessionSnapshot`）；正在形成的那根也能备注，快照带 `forming: true`。有备注的 K 线画紫色「注」方块（`#7c3aed`），悬停时图下方显示全文；3 秒 / 15 秒刷新（`setData`）后标记不丢。
- **「备注」标签**：列出全部来源、全部品种的 `kind=bar` 备注（按 K 线时间新的在上），每行「品种 · 来源 · 周期 · K 线时间 UTC」+ 备注前 40 字，可搜索（备注文字 / 品种 / 周期 / 来源），先画最新的 200 行。点一行 → 切到那个来源 / 品种、勾上它的周期、图滚到那根 K 线并把「注」标成琥珀色（`#f59e0b`）；切换品种 / 来源时重新读这个品种的备注。
- **Binance（合约 / 现货）直接从交易所拿**：历史 K 线永续走 `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=1000`，现货走同样的参数在 `https://api.binance.com/api/v3/klines`（两者都允许跨域，`access-control-allow-origin: *`），浏览器直连交易所，不经过后端、不导入数据库，所以任何 USDT 交易对都能看，不必先导入。返回 `[[开盘毫秒, "o","h","l","c","v", 收盘毫秒, …], …]`；最后一条是正在形成的那根（收盘时间在未来），页面把它当 forming，不当已收盘。产品列表取 `/fapi/v1/ticker/24hr`、`/api/v3/ticker/24hr`（全量，只留 `…USDT`）。
- **OKX 也直接拿**（CORS 回显 origin）：K 线 `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=15m&limit=300`（最新 1440 根以内），更早的分页用 `/api/v5/market/history-candles?…&after=<最早一根毫秒>`（最多 100 根）；返回新→旧，`[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]`，只有第一行可能 `confirm=0`（形成中）。周期写法 `1m 3m 5m 15m 30m 1H 4H 1Dutc`（大写 H；`1Dutc` 才是 UTC 日线，`1D` 是交易所的 UTC+8 日线）。产品列表 `/api/v5/market/tickers?instType=SWAP|SPOT`（`last`、`open24h`、`volCcy24h`），合约 instId 形如 `BTC-USDT-SWAP`，现货 `BTC-USDT`。
- **Deepcoin 经 Jesse 代理**（它不发 CORS 头，浏览器读不到）：K 线 `POST /review/market/candles` body `{source:'deepcoin', market:'swap'|'spot', symbol:'BTC-USDT-SWAP', interval:'15m', limit, before?}`（`before` = 已加载最早一根的开盘秒，服务端转成它的 `after` 毫秒参数要更早的一页），返回 `{candles:[…已收盘、旧→新…], forming:{…}|null, market, symbol, interval, limit, before, note, fetched_at, cached}`；产品列表 `POST /review/market/tickers` body `{source:'deepcoin', market}` → `{tickers:[{symbol, last, open24h, quoteVolume24h}]}`（只要 USDT，按成交额降序）。上游是 `https://api.deepcoin.com/deepcoin/market/candles|tickers`（`[ts,o,h,l,c,vol,volCcy]`，新→旧）。**它没有 3m**（`1m 5m 15m 30m 1H 4H 12H 1D 1W 1M 1Y`），所以 3m 那张图问 1m 由页面分桶（半成品桶就是形成中的那根）。白名单：symbol `^[A-Z0-9]{1,20}-USDT(-SWAP)?$` 且必须和 market 一致、周期白名单、limit 1~1000；超时 10 秒；缓存 K 线 2 秒、列表 10 秒；User-Agent 先试 requests 默认，被拒（403/451）再试 `Mozilla/5.0`，都不含主人信息、不用任何 key。
- **美债收益率由浏览器直连 CNBC（T-55）**：`https://ts-api.cnbc.com/harmony/app/charts/<RANGE>.json?symbol=US2Y` 与 `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US2Y|US10Y&…&output=json` 都带 `access-control-allow-origin: *`，所以不经过 Jesse、不需要登录（用 curl 默认 User-Agent 报价接口会 403，浏览器正常）。图表接口返回 `{barData:{priceBars:[{open,high,low,close,volume,tradeTimeinMills}]}}`（字符串数字、毫秒时间戳、旧→新，来源 Tradeweb，最新一根就是当前分钟），实测：`1D` 约 1 天 1 分钟线（~880 根）、`5D` 约 10 天 5 分钟线（~1350 根）、`6M` 约 3 年日线（~760 根）。CNBC 代码：US03M→`US3M`、US02Y→`US2Y`、其余同号。品种按 TradingView 习惯命名，**数值就是收益率本身**（4.02 表示 4.02%）：

  | 面板 | CNBC 区间 | 源 K 线 | 页面分桶（`aggregateCandles` 分钟数） |
  |---|---|---|---|
  | 1m / 3m | `1D` | 1 分钟 | 1 / 3 |
  | 5m / 15m / 30m / 1h / 4h | `5D` | 5 分钟 | 1 / 15 / 30 / 60 / 240 |
  | 1D | `6M` | 日线 | 1 |

  图下方写明「来源 CNBC（Tradeweb），1 分钟级，约 10 天盘中历史」（1m 面板是约 1 天，1D 面板是日线约 3 年）。**六个品种都有盘中数据**，T-53 那条「US02Y / US20Y 只有 FRED 日线」的限制和提示已去掉；后端的 us-yields 代理分支（Yahoo / FRED）保留着当备用，页面不再调用。
- **周期映射与聚合**：1m 5m 15m 30m 1h 1D 直接向交易所要；美债按上表取 CNBC 的区间，3m / 15m / 30m / 1h / 4h 由页面自己按 UTC 对齐分桶（`market-sources.mjs` 的 `aggregateCandles`）。**桶里有几根算几根**：债券一天不是 24 小时连续，要求满桶会把整个交易时段都丢掉。美债不翻页（CNBC 一次给一整段，没有更早的盘中数据），三个交易所的来源照旧往左加载。
- **美债没有 websocket**：每 15 秒拉一次 `1D`（当前时段的 1 分钟线），按开盘时间合并进每个面板自己的源序列、重新分桶，**最后一桶永远当作形成中**（画在最右边、指标末点跟着变）；1D 面板用最新一分钟的收盘更新「今天那根」（CNBC 的日线晚一个交易日，所以新时段的分钟会补出当天那根）。同时一次报价请求刷掉全部美债报价（自选 + 六行产品列表）。页面隐藏时停止轮询，切回来立刻拉一次；表头写「美债 · CNBC 每 15 秒更新」，浅红虚线轴标「实时」，标题写「US10Y 最新 4.021 · 今天 +0.03」。
- **往左拖到最早一根附近**（可见逻辑范围 `from < 50`）自动再拉更早的一页（Binance `endTime` = 最早一根开盘毫秒 − 1；OKX `after` 同毫秒；Deepcoin 代理的 `before` = 最早一根开盘秒），每个周期最多 5000 根，正在加载时不重复请求；加载后可见逻辑范围按新增根数平移，画面不跳。
- **实时（打开页面就有，没有开关）**：`live-price.mjs` 的 `klineStreamUrl` / `openKlines` 订阅 Binance 的公开 K 线组合流；OKX 用它自己的信封（`wss://ws.okx.com/ws/v5/business` 订阅 `candle15m` / `candle1H` / `candle1Dutc`…，`wss://ws.okx.com/ws/v5/public` 订阅 `tickers`，每 25 秒发一次文本 `ping` 保活）。正在形成的那根画在每张图最右边并随成交跳动，收盘的那根追加进已收盘数组（指标末点一起算好）；最新成交价画成浅红虚线（`#f19aa4`、lineWidth 1、lineStyle 2、轴标「实时」，与因子查找器同一条线）。**Deepcoin 没有多周期 K 线推送**（它的公开 socket 只有 ticker 主题和一个 1m K 线主题，且 spot 端没有 ticker 集群，都在 2026-11-16 实测），所以合约的价格走它的公开推送 `wss://stream.deepcoin.com/streamlet/trade/public/swap?platform=api`（`SendTopicAction` 订阅 TopicID 7，10 秒发一次 `ping`），K 线（含形成中那根）每 3 秒问一次 Jesse 代理（服务端缓存 2 秒），现货只轮询。断线按 1、2、4… 最多 30 秒重连；**重连成功后对每个周期重新拉最新一页并按开盘时间合并**，避免中间缺 K 线（缺一根布林线就断）。页面隐藏超过 1 分钟再回来也做同样的合并。
- **品种**：交易所是顶部输入框（Binance `btc` / `BTCUSDT` / `BTC-USDT`；OKX、Deepcoin `btc` / `BTC-USDT` / `BTC-USDT-SWAP`，页面按当前 market 换成对应 instId，见 `market-sources.mjs` 的 `symbolOf`；输入不存在的品种时交易所 REST 返回 400，页面给中文提示并保留当前图表）。选了美债来源时输入框换成下拉框，只能选那 6 个品种。
- **自选**：左侧窄栏，每一项都带来源、合约 / 现货和品种 `{source, market, symbol}`（美债 market 为 null），不同来源 / market 可以混排（同一个交易对在两个交易所、两个 market 都是不同的行），点哪一行就切到那个来源 + market + 品种（不是当前来源时先探一下新品种）；添加自选用当前来源 + market。旧格式（纯字符串数组、`binance-perp` / `binance-spot` 来源）自动迁移。每行显示最新值 + 当天变化：Binance 是 `@miniTicker` 组合流，OKX 是一条 `tickers` socket 带上全部自选（1 秒节流），Deepcoin 是 10 秒一次的产品列表读取（它的 spot 端没有 ticker 集群），美债是 CNBC 报价接口的 `change`（单位是百分点，`+0.03` 而不是百分比）、六个品种一次请求、每 15 秒刷新。第一次打开会把 US02Y US10Y US20Y US30Y 加进自选**一次**（localStorage `jesse.market.yields.v1` 记着已加过，删掉不会再回来），最多 20 个，存 localStorage `jesse.market.watchlist.v1`；当前图表存 `jesse.market.symbol.v1`（`{source, market, symbol}`，旧的纯字符串 / `binance-spot` 也能读）。
- **周期**：勾选框 1m 3m 5m 15m 30m 1h 4h 1D，默认 4h 1h 15m 5m，存 localStorage `jesse.market.timeframes.v1`。图按大周期在前排成两列网格（窄屏一列）；图高与因子查找器共用同一个选择（localStorage `jesse.finder.chartHeight.v2`）。
- **图表行为与因子查找器相同**（直接复用，不重写）：`linkTimeRanges`（拖动 / 滚轮按根数联动，别的图 K 线宽度不变）、只有鼠标所在的图驱动十字线、横线按价格同步到所有图、`enablePriceZoom` 的 A 按钮、每张卡的「截图」「放大」。截图保存给 Claude 走 `POST /review/screenshot`，和因子查找器一样从 `localStorage.main` 读登录 token（**Binance、OKX、美债看图不需要登录；Deepcoin 和存截图需要**）；复制 / 分享这类只有 https 或 localhost 才有的功能都有退路，所以从别的电脑用 `http://<局域网 IP>:9100` 打开也正常。
- **贴在最右边的图**：新 K 线出现时跟着往右走，K 线宽度不变（只用 `series.update()`，**不**每个 tick 调 `setVisibleRange`，那是 T-51 修过的坑）；拖到历史位置的图不动。
- **指标**：沿用复盘页「周期与指标」里保存的显示设置（`settings.mjs` 的 `STORAGE_KEY` + `restorePreferences`），主图叠加 MA 均线组 / SMA / EMA / BOLL，用 `calculateIndicator` 整段算；正在形成的那根用 `formingTail` 更新最后一点，每张图最多每 500ms 一次（美债的形成中那根就是最后一根聚合桶，15 秒轮询刷新）。副图指标（成交量 / MACD）不画——因子查找器也没画副图，两页口径一致。设置在那两页改，本页刷新后生效。
- **时间**：坐标轴和十字线都是 UTC，与其他页面一致；标题栏同时显示当前 UTC 时间和本地时间。每张图下面的小字是鼠标所指那根 K 线的开高低收（移开就回到最新一根），美债的图还写着数据来源。
- 纯函数在 `market-data.mjs`（交易对 / instId 规范化、三家交易所的 REST URL（`endTime` / `after`）与产品列表 URL、行解析与 forming 分离（`confirm=0`）、分桶面板的 forming 桶、产品列表解析 / 排序 / 搜索、`miniTicker` 解析、自选条目的规范化 / 新旧格式迁移 / 添加删除 / 默认美债播种、左栏标签与子标签的存取、周期的存取与容错、逻辑范围平移）和 `market-sources.mjs`（数据源与 market 白名单、旧数据源迁移、默认品种、各交易所的周期写法 `BARS` / `candleRequest`、美债的 CNBC 代码与区间 / 源 K 线映射 `yieldRequest`、CNBC 图表与报价解析、1 分钟轮询合并（含 1D 收盘更新）、UTC 分桶聚合、代理答案解析、百分点变化、时段指标 `sessionIndicator` / `sessionTail`），美债的 CNBC URL 在 `market-data.mjs`（`cnbcChartUrl` / `cnbcQuoteUrl`），测试在 `tests/review-market-data.test.mjs`、`tests/review-market-sources.test.mjs`（OKX / Deepcoin 的 socket 信封在 `tests/review-live-kline.test.mjs`）；后端解析 / 白名单 / 缓存 / 路由在 `tests/test_market_sources.py`（用固定样例字符串和假上游，不联网）。

## 标注（因子查找器里分开标「趋势判断」和「挂单」）

因子查找器里发现信号或挂单不对时，不再一张张截图：翻到那个信号，按一下键标“好 / 坏”，可加一句备注。每个信号有**两项独立标注**——「趋势判断」（这个信号该不该出现）和「挂单」（挂单价 / 成交 / 离场合不合理），所以一个“坏”能说清楚错在哪儿。标注写进**项目目录**（`jesse run` 的 cwd）下的当前「备注本」，默认就是 `storage/labels/finder-labels.jsonl`（见下面的「备注本」一节），调度/Claude 直接读这个文件分析，不需要截图。

**快捷键**（焦点在输入框、下拉框里时不响应）

- `←` / `→` 或 `k` / `j`：上一个 / 下一个信号（和工具栏按钮、`rides.mjs` 的 `neighbour` 同一套导航，遵守周期和标注筛选）。
- 趋势判断：`g` 好、`b` 坏；挂单：`f` 好、`v` 坏（键盘上 f / v 就在 g / b 左边）。标完只有**两项都标了**才跳到下一个信号；趋势标了“坏”时直接跳（趋势错了，挂单不用评）。
- 同一个键再按一次（比如已标「挂单好」再按 f）：只取消这一项，停在这个信号上。
- `0`：清除这个信号的两项标注（备注是单独一项，不跟着清）。
- `n`：打开一行备注输入框（页面内的，不用 `prompt`）。回车存成 `kind=note` 的一行，不要求先标好 / 坏；空着回车就是删掉这个备注；`Esc` 关掉输入框不保存。
- 列表每项右侧显示 `势✓` / `势✗` 和 `挂✓` / `挂✗`（没标的不显示），有备注时鼠标悬停显示备注；列表上方是「趋势 好 x / 坏 y · 挂单 好 x / 坏 y · 未标 z」统计（未标 = 两项都没标）、全部 / 未标 / 趋势坏 / 挂单坏 / 都好 筛选和一行快捷键说明。统计只按周期筛选算，不跟着标注筛选变。选中信号的信息栏也显示当前两项标注和备注。

**文件格式**：一行一条 JSON，只追加、不改旧行。字段：`key`（`factor|exchange|symbol|tf|start|dir`，前端在 `labels.mjs` 拼）、`kind`（`trend` / `order` / `note` / `bar`；缺省 = `trend`，所以旧行就是趋势标注）、`label`（`good` / `bad` / `clear`；`kind=note` 的行没有这个字段）、`note`、`factor`、`version`、`params`（这次实际用的因子参数）、`exchange`、`symbol`、`tf`、`start`（区间开始，UTC 秒）、`dir`（1 / -1）、`order`（当时页面上的挂单：算法 `rule`、挂单价 `price`、状态 `status`（`filled` / `open` / `unfilled` / `waiting`）、等了几根 `waitBars`、成交价 `fillPrice`、止损 `stop`、止盈 `target`、结果 `R`）、`saved_at`（UTC ISO）。

读法：同一个 `key`、同一个 `kind` 取**最后一条**，`clear` 表示取消这一项标注（这项变成空）；备注取该 key 最后一条带备注的行、或最后一条 `kind=note` 的行（`kind=note` 且备注为空 = 删掉备注）。三项全空的 key 不返回。页面用 `POST /review/labels {factor, exchange, symbol, book?}` 拿回 `{ labels: { key: { trend, order, note } }, bars: { key: { note, tf, time } } }`（`bars` 见下面的 K 线备注），接口做的就是这件事；也可以直接读文件。`book` 缺省 = 默认本（见下面「备注本」）。`key` 上限 200 字符，一条记录序列化后超过 8 KB 返回 413，备注超过 500 字符会截断（不丢标注）。

**接口**：`POST /review/label`（写一条，`{ok: true}`；`kind` 不是 trend/order/note 返回 400，trend/order 的 `label` 不是 good/bad/clear 也返回 400，`kind=note` 可以不带 `label`；`book` 可选，见下）和 `POST /review/labels`（读当前两项标注和备注，文件不存在返回空；`book` 可选），都在 `jesse/controllers/review_controller.py`，与截图接口同一个 router、同样需要登录。

**K 线备注**（任意周期图上的任意一根 K 线，不只信号）

- **双击**任意周期图的 K 线（不要双击价格轴 / 时间轴或最后一根之后的空白，那里没有 K 线，什么也不弹）→ 在该卡片顶部弹出输入框，标题如「10-27 08:36 UTC · 3m 这根 K 线的看法」，这根 K 线已有备注就预填。回车保存，`Esc` 取消，清空后回车 = 删除这条备注。单击行为保持不变；输入框打开时快捷键都不响应。
- 保存时页面把当时屏幕上的数据一起写进同一行：`bar`（`open` / `high` / `low` / `close` / `ma5` / `ma10` / `atr`（ATR(14)，Wilder 平滑）/ `bollUpper` / `bollMid` / `bollLower`（BOLL 20/2，总体标准差），都只用这根及之前的 K 线算）、`factor` / `version` / `params`（当前因子）、`tf`、`time`（这根 K 线的开盘时间，UTC 秒）、`signal`（当时选中的信号 `key`，没选就没有这个字段），所以以后看图也能知道当时在说什么。
- 存储：当前备注本（默认 `storage/labels/finder-labels.jsonl`），一行 `kind=bar`，`key` 为 `bar|exchange|symbol|tf|time`（前端 `labels.mjs` 的 `barKey`；周期在 key 里，所以 3m 的备注不会跑到同一时刻的 15m K 线上），只有 `note` 文字（与 `kind=note` 一样不需要 `label`）；空 `note` 的一行就是删除。读法和其他行一样：每个 key 取最后一条，空 `note` 不返回。
- `POST /review/labels` 的答案变成 `{labels: {...}, bars: {key: {note, tf, time}}}`：`bars` 只按 `exchange` / `symbol` 过滤（K 线备注与因子无关，切因子照样显示），`labels` 里不会混入 `bar` 行，旧字段和行为不变。
- 有备注的 K 线在**它自己的周期图**上画一个紫色方块「注」（`#7c3aed`，`aboveBar`）：和信号标记一起交给 `setMarkers`，选中信号的高亮 / 入场平仓标记都不受影响；鼠标悬停到那根 K 线时，状态条下面显示完整备注。列表上方多一行小字提示「双击图上任意 K 线可写看法」。

**测试**：`tests/review-labels.test.mjs`（`labels.mjs` 的 `labelKey` / `labelCounts` / `countsText` / `latestLabels` / `filterByLabel` / `barKey` / `latestBars` / `barNoteOf` / `barLabel` / `barMarkers`）、`tests/review-bar-notes.test.mjs`（`bar-notes.mjs`：两页的 exchange / symbol 命名、同一根 K 线的 key、备注列表的解析 / 排序 / 搜索、会话市场快照）、`tests/review-label-books.test.mjs`（备注本：名字校验、localStorage 读写容错、存的本不在了的回退、请求体带 `book`）、`tests/test_review_labels.py`（写入、kind 缺省为 trend、order 与 trend 互不覆盖、备注单独存 / 清、clear、非法 kind 和 label、旧行兼容、超长 413、按 factor/symbol 过滤；K 线备注的存 / 改 / 删、不混入 labels、按品种和周期过滤、手写行从 key 读回 tf / time；备注本的默认本兼容、本与本隔离、名字校验、不存在的本写入 404 / 读取为空、列本与新建、重名 409）。

## 备注本（多本笔记）

**一个备注本 = `storage/labels/` 下的一个 `<名字>.jsonl`**（还是 `jesse run` 的 cwd 下的项目目录）。信号标注（`trend` / `order`）、信号备注（`kind=note`）和 K 线备注（`kind=bar`）都属于当前打开的那一本，换一本就是换一个干净的工作面，旧本原样保留。**默认本叫 `finder-labels`**，就是 T-57 之前唯一那个文件，所以旧数据和没换过本的页面照旧工作，不需要迁移。

- **在哪、怎么切**：因子查找器左栏「趋势 好 x / 坏 y · …」统计下面一行「备注本：[下拉] [新建]」；看行情页左栏「备注」标签里、搜索框上方同一个控件（顶部时钟那行也写着当前本名）。下拉每项是「名字（N 条）」，按最近写过排序。切换后立刻重新读那一本的标注和 K 线备注，重画紫色「注」和列表；保存一律写当前本。
- **两个页面同一本**：选择存在 localStorage `jesse.labels.book`（一个共用 key），在一个页面切换，另一个页面刷新后跟着换。**存的本在服务器上不在了**（被删 / 改名 / 换了项目目录）就回退默认本，并在控件旁边提示是哪一个本不在了，不会闷声显示另一本的内容。
- **新建**：点「新建」在同一行出现输入框（不用 `window.prompt`），回车新建并切过去，`Esc` 取消；名字不合法或重名就在旁边写中文错误。
- **名字规则**：`^[A-Za-z0-9_\-一-鿿]{1,40}$`——中英文、数字、`_`、`-`，1–40 字；不许 `/`、`.`、空格（名字直接当文件名，所以不能跳出 `storage/labels/`）。不合法返回 400。
- **没有删除和改名**，防误删：要删 / 改名就让主人手动处理 `storage/labels/*.jsonl`。`storage/labels/` 下别的文件（名字不合法的、非 `.jsonl` 的）不会出现在下拉里。
- **追加写不变**：还是只往当前本追加一行，不改写旧行；一行里不重复记 `book`（文件名就是本名）。
- **Claude 怎么读**：直接读 `storage/labels/*.jsonl`——默认 `finder-labels.jsonl`，其余按文件名就是本名。也可以用 `POST /review/labels`（加 `book`，缺省默认本）；不存在的本读取返回空（不会报错），写入返回 404「备注本不存在，先新建」。
- **接口**：`POST /review/label-books`（无参数）→ `{books: [{name, rows, updated}], default: 'finder-labels'}`，`rows` = 行数，`updated` = 最后写入的秒级时间戳，按最近修改倒序；默认本即使还没写过也会列出来（`rows: 0, updated: 0`，第一次写入就建文件）。`POST /review/label-books/create {name}` → 新建空文件 `{ok: true, name}`；已存在返回 409。两个接口都需要登录。

## 截图与标注

给两个页面（`index.html` 复盘页、`finder.html` 因子查找器）用，方便把图发给 Claude 讨论：截图 → 简单画几笔 → 一键存到 Mac 上的固定文件夹。手机上（iPad、iPhone 经 Tailscale 打开）也能用。

**按钮在哪**

- 每张图卡片标题行的右边有「截图」：只截这一张。复盘页截「主图 + 当前显示的副图」，因子查找器截这一张周期图。标题栏左边是周期（如 `3m`），右边是品种/回测标题加当前选中交易（或区间）的那行文字。
- 工具栏的「截全部」：把所有有图的卡片按 2 列拼成一张，最上面一条总标题栏写页面名、品种、时间（UTC）和当前选中项。

**标注工具**

- 上方工具条：画笔、箭头、直线、方框、文字（选中的高亮）；颜色红、绿、蓝、黄、黑（默认红）；撤销、清空；右边是复制、下载、保存给 Claude、分享（浏览器支持分享文件时才出现）、关闭。
- 画布按比例缩放到适合屏幕；鼠标、手指、Apple Pencil 都能画（用的是 pointer 事件）。线宽和字号按原图宽度换算，所以导出的是原分辨率，不会因为预览小就变细。
- 文字：点一下位置会出现一个小输入框，回车或点别处后画上去（白描边，压在 K 线上也看得清）。Esc 关掉输入框不画；没有输入框时 Esc 关闭整层。
- 每一笔（一次按下到抬起）是一条记录，撤销就是删掉最后一条重画，底图不动。清空只清标注。

**保存到哪**

- 「保存给 Claude」把图存到 **`jesse run` 所在项目目录**下的 `storage/screenshots/`：文件名是 UTC 的 `YYYYMMDD-HHMMSS-<label>.png`（label 如 `finder-3m`、`finder-all`、`review-3m`、`review-all`），同一秒同名会加 `-2`、`-3`；`latest.png` 永远覆盖成最新的一张。
- 工具条里「备注（可选）」有字时，会写一份同名 `.txt`（最长 2000 字符）。存好后页面会显示文件名，提示「跟 Claude 说『看最新截图』即可」。
- 上传走 `POST /review/screenshot`（body `{image, label, note}`，`image` 是不含 `data:` 前缀的 base64 PNG）。服务端只接受 PNG 文件头（否则 400），超过 15 MB 返回 413；一张 4 图拼接截图通常 1–3 MB。

**复制/下载/分享的区别**

- 「复制」调用剪贴板写图片，桌面浏览器可以直接粘给 Claude；不支持的浏览器（Safari、部分手机浏览器）会提示改用下载或保存给 Claude。
- 「下载」就是普通下载，文件名同上；「分享」调系统分享面板（手机上可发到别处）。

**实现与测试**

- 全部在 `snapshot.mjs`：`captureCard`（一张卡片）、`captureGrid`（网格拼接）、`openAnnotator`（遮罩层）、`gridLayout` / `snapshotFileName` / `utcStamp`（纯函数）。图表图片用 Lightweight Charts 自带的 `chart.takeScreenshot()`，没有新增依赖。
- `tests/review-snapshot.test.mjs` 测纯函数，`tests/test_review_screenshot.py` 测后端保存（正常保存、latest.png、备注、非 PNG 400、label 清洗、重名加后缀）。

## 放大单张图

每张图标题右边「截图」旁有「放大」：这张图占满图表区，其他周期暂时隐藏；按钮变成「还原」，再点一次或按 Esc 回到多图。隐藏的图仍在后台跟着时间联动，还原后位置正确。代码在 `snapshot.mjs` 的 `toggleMaximize` / `addMaximizeButton`，样式是 `review.css` 的 `.chart-grid.has-maximized`。
