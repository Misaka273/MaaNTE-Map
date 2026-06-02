# 异环 · 海特洛市探索地图

基于 Vue 3、Leaflet 和 Vite 的本地交互式地图。地图瓦片由游戏文件解包后的高清底图生成，不依赖在线地图服务。

## 启动

```powershell
npm install
npm run dev
```

开发服务器默认运行在 `http://127.0.0.1:5173`。当前机器如果遇到全局 `npm` 入口损坏，也可以使用：

```powershell
.\scripts\start-dev.ps1
```

## 本地数据

地图数据维护在 `src/data/map-data.json`，不再从第三方接口同步。文件包括：

- `map`：底图像素尺寸、瓦片尺寸、世界原点像素与缩放比例。
- `categories`：本地分类定义。分类可通过 `isHidden: true` 暂时从浏览界面隐藏。
- `locations`：点位数据，支持多类型、描述、标签和截图。
- `routes`：路线与有序路段。

历史导入快照已经通过 Python 脚本清洗。脚本也可以重复执行，用于删除误加入的冗余字段：

```powershell
npm run clean:locations
```

如需转换旧版 `locations.generated.js`，显式指定输入文件：

```powershell
python .\scripts\clean-locations.py --input .\legacy\locations.generated.js
```

## 编辑地图

通过 `npm run dev` 启动本地开发服务器后，点击页面右上角的“编辑地图”：

1. 点击地图空白处新建点位。
2. 在点位详情中编辑或删除点位。
3. 一个点位可以选择多个类型，也可以添加可复用的自定义类型。
4. 点位可以上传多张截图，详情页支持预览。
5. 路线面板可以新建路线，再依次点击标点建立路段。

编辑结果写回 `src/data/map-data.json`，截图保存在 `public/images/uploads/`。生产构建和静态部署保持只读。

隐藏分类仍然会出现在编辑表单的“类型（可多选）”列表中，用于继续维护点位数据。隐藏分类不会出现在浏览侧边栏、地图标记、点位详情标签和探索进度中。当前暂时隐藏“异象委托”和“资源”分组下的所有类型。

编辑表单中的“搜索关键词（可选）”用于补充搜索命中词，不是点位类型。关键词使用英文逗号分隔，不会出现在分类侧边栏中。

## 开发说明

### 目录结构

- `src/App.vue`：地图界面、筛选、编辑器和路线交互。
- `src/data/map-data.json`：可编辑的地图数据快照。
- `src/data/locations.js`：地图坐标转换。
- `vite.config.js`：Vite 配置，以及仅在开发服务器中启用的本地写入接口。
- `scripts/clean-locations.py`：清洗本地数据或转换旧版快照。
- `scripts/generate-map-tiles.ps1`：从原始底图生成本地瓦片。
- `scripts/qa-map.mjs`：浏览器端基础回归检查。

### 分类字段

每个 `categories` 条目包含以下字段：

- `id`：稳定标识，点位通过 `types` 数组引用它。
- `group`、`label`：侧边栏分组和显示名称。
- `icon`、`color`：地图标记样式。
- `isDefault`：保留的导入字段。
- `isHidden`：可选。设为 `true` 时仅在编辑器中保留，不进入浏览界面。

暂时隐藏分类时不要删除分类或点位数据；设置 `isHidden: true` 即可。恢复展示时移除该字段或改为 `false`。

通过编辑器添加的自定义类型会写入 `categories`，并自动勾选到当前点位。新增时必须填写稳定的类型 ID，并可以选择已有标记大类；也可以填写“新建大类（可选）”，将类型归入新的侧边栏分组。若填写的 ID 已存在，编辑器会依次追加 `-2`、`-3` 等数字后缀。后续编辑其他点位时可以直接复用。

### 本地接口

`npm run dev` 会通过 Vite 中间件提供两个仅用于本地编辑的接口：

- `GET /api/map-data`：读取最新的 `src/data/map-data.json`。
- `POST /api/map-data`：写回地图数据。
- `POST /api/upload-image`：把点位截图写入 `public/images/uploads/`。

`npm run build` 生成的静态站点不包含写入能力。

### 修改流程

1. 运行 `npm install` 安装依赖。
2. 运行 `npm run dev`，在浏览器中检查交互和编辑写入。
3. 修改分类或点位后，按需运行 `npm run clean:locations` 统一数据格式。
4. 提交前运行 `npm run build` 和 `npm run qa`。

## 重新生成地图瓦片

默认读取 `C:\Users\owo\Desktop\navi_dev\bigworldmap.png`：

```powershell
.\scripts\generate-map-tiles.ps1
```

也可以显式指定其他原图：

```powershell
.\scripts\generate-map-tiles.ps1 -Source "D:\maps\bigworldmap.png"
```

## 坐标与扩图

点位持久化为游戏世界坐标。渲染时使用固定变换：

```text
pixelX = worldOriginPixel.x + lng * pixelsPerWorldUnit
pixelY = worldOriginPixel.y - lat * pixelsPerWorldUnit
```

当前配置为 `44 px / 世界坐标单位`，世界原点位于像素 `(11264, 11264)`。

扩图时不要按新图片尺寸重新缩放已有点位：

- 向右或向下追加 `512 × 512` 瓦片：只更新 `map.width` 或 `map.height`。
- 向左追加瓦片：增加 `map.worldOriginPixel.x`。
- 向上追加瓦片：增加 `map.worldOriginPixel.y`。

这样旧点位不会因为底图尺寸变化而漂移。

## 验证

```powershell
npm run build
npm run qa
```
