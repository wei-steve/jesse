# Jesse 多周期复盘扩展页

原型入口：`/review/index.html?session=<backtest UUID>`。在与 Jesse 相同的 origin（包括 hostname 和端口）登录后使用。页面读取现有认证的 session/chart-data POST 接口，不创建回测、不下单、不修改策略或结果。

这是独立的静态扩展页，原 dashboard 的 Trade Chart 和菜单未修改。没有 dashboard-v1 源码时，不应逆向修改压缩的 Vue bundle。后续可以把此页入口接入源码中的回测结果组件。

## 使用

- 需要保存了图表数据的 **1m 交易路由**。
- 左侧选择交易，各周期图一起定位到入场；使用“定位离场”“上一笔”“下一笔”逐笔检查。
- “周期与指标”面板：从 1m–1D 中勾选任意多个显示周期，至少 1 个（默认显示策略配置的全部周期，标“策略”）；添加、编辑、移除指标。主图叠加 SMA / EMA / 布林带，附图显示 RSI / MACD / ATR / 成交量，每个附图指标一个独立小图，与主图时间轴对齐联动。最多 10 个指标，设置保存在当前浏览器（`jesse.review.display.v1`），改设置时不重新读取数据，保持当前交易和时间窗口。
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
