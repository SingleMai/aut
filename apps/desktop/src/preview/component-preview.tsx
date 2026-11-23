import { ReducedCharacterMotion, wink } from "@aut/characters";
import { type BotConfig, BotId } from "@aut/protocol";
import { Button, SegmentedControl, Select, Switch } from "@radix-ui/themes";
import { Effect } from "effect";
import { useId, useState } from "react";
import { createRoot } from "react-dom/client";
import { Wordmark } from "../brand.js";
import { CharacterEditor } from "../characters/character-editor.js";
import { ClassifierModelFields } from "../classifier-settings.js";
import { readSettingsForm } from "../configuration-forms.js";
import { ConversationBody } from "../conversation-body.js";
import { ConfigurationForm } from "../ui/configuration-form.js";
import { type DesktopAppearance, DesktopTheme } from "../ui/theme.js";
import { QuestionPreview } from "./question-preview.js";

const bot: BotConfig = {
  id: BotId.make("qa-research"),
  name: "研究助手",
  characterId: wink.id,
  cwd: ".",
  soul: "",
  description: "检查桌面交互",
  modelSelection: { instanceId: "qa-local", model: "fixture" },
};

function FormPreview() {
  const [message, setMessage] = useState("");
  return (
    <section className="preview-section">
      <header className="preview-section-heading">
        <h2>表单校验</h2>
      </header>
      <ConfigurationForm
        className="preview-form"
        flash={setMessage}
        submit={(data) => {
          setMessage("");
          return readSettingsForm(data, []).pipe(
            Effect.tap(() => Effect.sync(() => setMessage("校验通过。"))),
          );
        }}
      >
        {(busy) => (
          <>
            <input type="hidden" name="primary.backend" value="fixture" />
            <ClassifierModelFields
              slot="primary"
              value={{ model: "fixture-v1", endpoint: "https://" }}
              required
            />
            <div className="preview-form-actions">
              <span className="muted" role="status">
                {message}
              </span>
              <Button type="submit" disabled={busy}>
                校验配置
              </Button>
            </div>
          </>
        )}
      </ConfigurationForm>
    </section>
  );
}

function ComponentPreview() {
  const [appearance, setAppearance] = useState<DesktopAppearance>("system");
  const [width, setWidth] = useState("wide");
  const [reduced, setReduced] = useState(false);
  const motionId = useId();
  return (
    <DesktopTheme appearance={appearance}>
      <ReducedCharacterMotion value={reduced}>
        <main className="component-preview" data-reduce-motion={reduced || undefined}>
          <div className="preview-paper">
            <header className="preview-header">
              <Wordmark />
              <div>
                <h1>桌面组件预览</h1>
                <p className="muted">示例操作只在本页生效。</p>
              </div>
            </header>
            <div className="preview-toolbar">
              <div>
                <span>外观</span>
                <Select.Root
                  value={appearance}
                  onValueChange={(value) => setAppearance(value as DesktopAppearance)}
                >
                  <Select.Trigger aria-label="预览外观" />
                  <Select.Content>
                    <Select.Item value="system">跟随系统</Select.Item>
                    <Select.Item value="light">浅色</Select.Item>
                    <Select.Item value="dark">深色</Select.Item>
                  </Select.Content>
                </Select.Root>
              </div>
              <div>
                <span>预览宽度</span>
                <SegmentedControl.Root value={width} onValueChange={setWidth} aria-label="预览宽度">
                  <SegmentedControl.Item value="wide">宽幅</SegmentedControl.Item>
                  <SegmentedControl.Item value="narrow">窄幅</SegmentedControl.Item>
                </SegmentedControl.Root>
              </div>
              <div>
                <Switch id={motionId} checked={reduced} onCheckedChange={setReduced} />
                <label htmlFor={motionId}>减少动态效果</label>
              </div>
            </div>
            <div className="preview-frame" data-width={width}>
              <div className="preview-grid">
                <QuestionPreview />
                <CharacterEditor bot={bot} name={bot.name} />
                <FormPreview />
                <section className="preview-section preview-code">
                  <header className="preview-section-heading">
                    <h2>代码片段</h2>
                  </header>
                  <ConversationBody
                    user={false}
                    text={'```ts\nconst appearance = "system";\nconst previewWidth = 390;\n```'}
                  />
                </section>
              </div>
            </div>
          </div>
        </main>
      </ReducedCharacterMotion>
    </DesktopTheme>
  );
}
const app = document.getElementById("app");
if (app) createRoot(app).render(<ComponentPreview />);
