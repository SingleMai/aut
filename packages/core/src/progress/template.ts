import type { Task } from "@aut/protocol";

const statuses: Record<Task["status"], string> = {
  created: "已创建",
  running: "进行中",
  waiting_user: "有待回答的问题（任务可能仍在继续）",
  reporting: "正在整理回包",
  idle: "空闲，等待后续指令",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
  archived: "已归档",
};
const timestamp = (value: number) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "时间未知";
};
export const fastProgressText = (task: Task, botName: string): string => {
  const name = Array.from(botName.replace(/\s+/gu, " ")).slice(0, 24).join("");
  const text = `『${name}』任务当前${statuses[task.status]}。\n创建：${timestamp(task.createdAt)}；最近活动：${timestamp(task.lastActivityAt)}。\n待回答 ${task.pendingRequestIds.length} 项。详情见任务面板。`;
  return Array.from(text).slice(0, 200).join("");
};
