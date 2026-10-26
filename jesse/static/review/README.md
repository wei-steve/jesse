# Jesse 多周期复盘扩展页

原型入口：`/review/index.html?session=<backtest UUID>`。在与 Jesse 相同的 origin（包括 hostname 和端口）登录后使用。页面读取现有认证的 session/chart-data POST 接口，不创建回测、不下单、不修改策略或结果。

这是独立的静态扩展页，原 dashboard 的 Trade Chart 和菜单未修改。没有 dashboard-v1 源码时，不应逆向修改压缩的 Vue bundle。后续可以把此页入口接入源码中的回测结果组件。

## 使用

- 需要保存了图表数据的 **1m 交易路由**。
- 左侧选择交易，四图定位其入场；使用“定位离场”“上一笔”“下一笔”逐笔检查。
- 每图独立计算对应周期的 SMA5，蓝框标出入场前最近记录的 MA5 context 周期。
- 拖动、滚轮缩放一个图时，其余图跟随时间范围；十字线定位到同一时刻所在的各周期 K 线。
- 6/12/24 小时窗口可以切换；显示全部成交默认关闭，避免标记重叠。
- 所有时间是 UTC，区别于原 dashboard 可能显示的本地时间。盈亏显示保存的 USDT 净盈亏，不显示杠杆保证金 ROI。

## 数据边界

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
node --test tests/review-data.test.mjs
node --check jesse/static/review/app.mjs
docker cp jesse/static/review/. jesse:/jesse-docker/jesse/static/review/
```

首次安装先复制整个目录，目标目录无需预先创建：

```sh
docker cp jesse/static/review jesse:/jesse-docker/jesse/static/
```

当前适配此仓库已打包的 Lightweight Charts 组件 `../_nuxt/eDEyLi0S.js`（`t` 为 createChart）。该组件不访问 CDN。未来升级 dashboard 改变 chunk 名称或导出接口时需要更新这一处适配，并重新验证。

Jesse 已有静态文件服务会直接读取新文件，安装无需重启。文件只复制到当前容器；重建/替换容器会丢失副本，源码保留在此仓库，可以重新复制。回滚时移除新增 `review` 目录即可，原 dashboard、后端及数据库未修改。
