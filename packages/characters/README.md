# aut 角色模块

`@aut/characters` 提供 React 播放器、形象注册表，以及单眼 a 和纸鸟两种内置形象。会话负责判断发生了什么，每个形象决定如何表达。

## 使用播放器

```tsx
import { CharacterPlayer, paperBird } from "@aut/characters";
import "@aut/characters/styles.css";

export function QuestionAvatar({ waiting, deliveredId }: { waiting: boolean; deliveredId?: string }) {
  return (
    <CharacterPlayer
      character={paperBird}
      state={waiting ? "question" : "idle"}
      event={deliveredId ? { name: "received", key: deliveredId } : undefined}
    />
  );
}
```

通过 `.aut-character` 的宽高控制显示尺寸。`size="small"` 适合会话头像，较大的预览使用 `size="regular"`。颜色继承 `currentColor`，强调色可用 `--aut-character-accent` 覆盖。使用单眼 a 或字标时，在页面内联一次包导出的 `@aut/characters/aut.svg`，外层使用零宽高、溢出隐藏的装饰容器。桌面构建在生成 HTML 时完成这一步。纸鸟和自带资源的角色可以单独使用。

| 输入 | 时机 |
| --- | --- |
| `state="idle" / "thinking" / "question"` | 待命、工作中、等待用户回答，持续到状态更新 |
| `event.name="received"` | 原生问题从未确认转为已送达 |
| `event.name="report"` | 当前会话收到带完整报告的回复 |
| 自定义 `event.name` | 由角色声明，可在编辑器单独预览 |

每个实例独立计时。同一次事件保持相同的 `key`，重复渲染会沿用播放进度。再次触发同名动作时传入新的 `key`。新事件会替换当前动作，清空事件或卸载播放器会取消播放。动作自然结束时调用 `onActionEnd`，随后显示最新的 `state`。

读取历史时只传入持续状态。实时进入状态时可开启 `animateEntry`。系统启用减少动态效果时，渲染器收到 `animate=false`，短动作按原时长展示静帧。宿主也可以用 `<ReducedCharacterMotion value={true}>` 让一组角色显示静帧。播放器是装饰图形，界面负责提供名称或状态文字。

## 接入一个形象

例如，一套 PNG 序列可以把每个姿态的静帧和动画素材映射到同一渲染器。

```tsx
import {
  type CharacterDefinition, type CharacterPose, characters,
  conversationStates, conversationActions, createCharacterRegistry,
} from "@aut/characters";

function Cloud({ state, action, animate }: CharacterPose) {
  const pose = action ?? state;
  return <img alt="" src={`/cloud/${pose}.${animate ? "webp" : "png"}`} />;
}

const cloud: CharacterDefinition = {
  id: "cloud",
  label: "云朵",
  Render: Cloud,
  states: { ...conversationStates, sleeping: { label: "打盹" } },
  actions: {
    ...conversationActions,
    wave: { label: "挥手", durationMs: 800 },
  },
};

export const catalogue = createCharacterRegistry([...characters.list, cloud]);
```

示例需要 `idle`、`thinking`、`question`、`sleeping`、`received`、`report`、`wave` 对应的素材。渲染器也可返回 SVG 或 Canvas，并同时使用 `state` 与 `action`，例如让一只正歪头等回答的纸鸟扇动翅膀。持续姿态在 `states` 中声明，`entryMs` 可指定进入姿态的动画时长。播放器遇到未知状态时回到待命，遇到未知动作时继续展示当前状态。

### 注册到桌面

1. 在 `src/builtins/<id>/` 放入渲染器、状态、动作定义及所需资源。纸鸟提供了一份包含专属状态和短动作的完整示例。[纸鸟实现](src/builtins/paper-bird/index.tsx)
2. 把定义加入包导出的 `characters` 注册表。如果角色有专属 CSS，从包的样式入口引入。[形象注册表](src/index.ts) · [样式入口](styles.css)
3. 打开组件预览，在「角色形象」中选择新角色。选择器读取注册表，状态和短动作按钮读取该角色的 `states`、`actions`。在 Bot 配置页保存形象后可核对会话头像。[组件预览](../../docs/desktop.md#组件预览) · [Bot 与设置](../../docs/desktop.md#bot-与设置)

仅扩展现有形象的专属动作时，在该角色的 `actions` 中添加稳定名称、展示名、正数毫秒时长，并在渲染器实现动作姿态。让真实会话触发一个新动作时，由对应界面在事件发生处传入 `event`。[角色模块决策](../../docs/decisions/0053-bot-character-module.md)

Bot 配置持久化稳定的 `characterId`。已有配置缺少该字段或当前形象尚未安装时，主助手显示单眼 a，普通 Bot 显示名称首字。编辑其他字段会保留尚未安装的形象 ID。
