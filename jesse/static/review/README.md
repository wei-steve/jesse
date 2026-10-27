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

- `index.html` 里的内联加载器用 `const REVIEW_VERSION = '…'` 动态 `import(`./app.mjs?v=${REVIEW_VERSION}`)`，样式表是 `review.css?v=…`。`index.html` 本身是页面请求，普通刷新会重新校验。
- 每个 `.mjs` 里的相对 import 都写成 `'./xxx.mjs?v=…'`（同一个版本号；`../_nuxt/…` 图表库文件名自带哈希，不需要）。

**以后改了 `jesse/static/review/` 里任何文件（`.mjs`、`.css`、`index.html`），提交前必须换版本号：**

1. 选一个新版本号，建议日期加字母，如 `20261027c`（当天再改就 `b`）。
2. 把 `index.html` 和 `finder.html` 里的 `REVIEW_VERSION`、`review.css?v=` 和所有 `.mjs` 文件里 `?v=` 后面的旧版本号全部替换成新的（可用 `grep -rn "?v=" jesse/static/review/` 找，或全局替换旧版本号字符串）。
3. 新增模块时，import 也要写成带同一个 `?v=` 的形式。
4. 运行 `node --test tests/review-*.test.mjs`。`tests/review-version.test.mjs` 会检查 `index.html` 和所有 import 的版本号一致，漏改会报错（它不能检查你“有没有换新版本号”，所以第 1 步要自己记得）。
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

当前适配此仓库已打包的 Lightweight Charts v4 组件 `../_nuxt/eDEyLi0S.js`（`t` 为 createChart）。该组件不访问 CDN。升级 Jesse 后 dashboard 重新打包可能改变 chunk 名称或导出接口，届时需要更新 `app.mjs` 第一行的导入并重新验证。

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
- 每张周期图只画本周期的区间：区间第一根 K 线上一个标记（`MA10↑` 绿箭头在下，`MA10↓` 红箭头在上）；区间内把所骑的均线（该周期 K 线上的 SMA N，N 随区间里的值变化）画成粗线。每个区间是单独的一条线（图表库会把同一条线上相邻的点连起来，空白点也不能断开，所以区间之间不能共用一条线），区间之间一定断开。落点：值在 time+60 已知，对应收盘时间 ≤ time+60 的最后一根该周期 K 线；已结束的区间画到“收盘时间 ≤ 结束点 time+60 的那根”之前。均线预热不足的 K 线不画。
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
  - `start`/`finish`：UTC，ISO 字符串（没写时区按 UTC）或毫秒数；取整到分钟；包含开盘时间在 [start, finish] 内的 1m K 线。`finish` 省略 = 数据库里该品种最新一根 1m。范围上限 45 天（超过 400）；`finish` 不晚于 `start` 也是 400；范围内没有 K 线 404。
  - 不用 `get_candles_from_db`（它把起止取整到整天，会丢掉今天），用 `_get_candles_from_db` 按精确时间读 1m，自己合成 3m/5m/15m/1h…（支持到 1D；周和月没有干净的对齐方式，不提供）。**只保留完整的 K 线**：桶里缺任何一根 1m、或还没走完（最后一根未收盘的高周期 K 线）都不要，与复盘页口径一致。
  - 每个周期往前多取 `WARMUP_BARS` 根给 `compute`，返回前去掉；开盘时间早于 `start` 的 K 线算 warmup。
  - 返回 `{factor, title, version, exchange, symbol, params（实际使用的）, start, finish, last_candle_time, timeframes: {tf: {candles: [{time,open,high,low,close,volume}], value: [...], touches: [...], label?}}}`，时间全是 UTC 秒；`candles`、`value`、`touches` 一一对应；`last_candle_time` 是读到的最后一根 1m 的开盘时间。

**页面**
- 顶部表单：交易所（默认 Binance Perpetual Futures）、品种（默认 BTC-USDT）、范围（最近 1/3/7/14/30/45 天到最新，默认 7 天；或自定义 UTC 起止，结束留空 = 最新）、因子下拉框（TITLE + VERSION）、PARAMS 输入框（超出范围自动截回）、周期勾选（默认因子的 TIMEFRAMES）。表单内容保存在浏览器（`jesse.finder.form.v1`），下次打开恢复，打开页面和点“查找”都会重新读取最新数据。
- “更新到最新”：调 `POST /candles/import`（start_date = 昨天 UTC），每 2 秒轮询 `/candles/import-status`，完成后自动再查找；失败时显示错误。顶部写“数据到 xx:xx UTC”，数据落后超过 10 分钟时提示。
- 结果：左侧区间列表（周期、↑/↓、均线、开始时间、根数；按周期过滤，上一个/下一个），点击后各周期图一起定位；图默认只画 K 线和所骑的均线（粗线，区间之间断开，起点标记 `MA10↑`）。勾选“叠加复盘页的显示设置”后把复盘页保存的主图指标（MA 均线组、SMA、EMA、布林带）叠上来。
- 状态条与“最新”视图：查找完成后默认定位到最后一根，状态条写此刻各周期状态和各周期的建议（`1h ↑MA20 · 15m — · …` / `1h、5m 向上 → 不宜做空；3m 向下 → 不宜做多`，都没有就写“各周期都没有沿均线走”）；“跳到最新”随时回到这里；点区间或鼠标移到图上时状态条跟着变。
- 区间从所选范围的起点开始算（范围之前已经开始的区间被截断）；画均线用范围内的 K 线计算，均线周期大于范围内已有 K 线根数时起点附近画不出线。
- 测试：`tests/test_factor_finder.py`（后端，用示例因子和造的 K 线）、`tests/review-finder-data.test.mjs`（表单、请求、阶梯序列转换）。
