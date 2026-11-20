// Copied from OpenMausBot (Apache-2.0), src/locales/{en,zh,pt-br,es}.json.
// Commit: 738ec88472a3b888ff7b7793755d89da613ed301. Copyright 2026 Milind Soni and contributors.
// Selected desktop conversation, tool and sidebar entries. See NOTICE.
// Only toolDetail.previewHint is adapted: aut displays recorded input/output without claiming redaction.
export const en = {
  "chat.messageActions": "Message actions",
  "sidebar.searchClose": "Close search",
  "task.updated.justNow": "just now",
  "task.updated.minutes": "{count} min ago",
  "task.updated.hours": "{count} h ago",
  "task.updated.yesterday": "yesterday",
  "task.updated.days": "{count} d ago",
  "chat.reply.replyingTo": "Replying to {name}",
  "chat.reply.jump": "Jump to original message",
  "chat.reply.cancel": "Cancel reply",
  "chat.copyLink": "Copy link",
  "chat.showFull": "Show full message",
  "chat.showLess": "Show less",
  "chat.spoiler.reveal": "Reveal spoiler",
  "chat.spoiler.hide": "Hide spoiler",
  "chat.spoiler.hideShort": "Hide",
  "code.copyTitle": "Copy code",
  "code.copiedTitle": "Copied to clipboard",
  "code.wrapLines": "Wrap lines",
  "common.copyFailed": "Could not copy",
  "chat.more": "More",
  "code.saveAsFile": "Save as file",
  "question.showFull": "Show full question",
  "question.showLess": "Show less",
  "toolDetail.label": "{name} · {status} · Tool details",
  "toolDetail.input": "Input",
  "toolDetail.output": "Result",
  "toolDetail.running": "Running",
  "toolDetail.failed": "Failed",
  "toolDetail.completed": "Completed",
  "toolDetail.unverified": "No result",
  "toolDetail.waiting": "Waiting for the tool to finish…",
  "toolDetail.noOutput": "No output was recorded for this call.",
  "toolDetail.loadingFull": "Loading the full result…",
  "toolDetail.partial": "Showing the start of the result only: the rest could not be loaded.",
  "toolDetail.previewHint": "Tool input and output from this session. Review before sharing.",
  "toolDetail.tool": "Tool",
  "toolStep.runCommand": "Run a command",
  "toolStep.readFile": "Read a file",
  "toolStep.writeFile": "Write a file",
  "toolStep.editFile": "Edit a file",
  "toolStep.deleteFile": "Delete a file",
  "toolStep.searchFiles": "Search files",
  "toolStep.searchWeb": "Search the web",
  "toolStep.openWebPage": "Open a web page",
  "toolStep.lookAtScreen": "Look at the screen",
  "toolStep.useComputer": "Use the screen",
  "toolStep.useBrowser": "Use the browser",
  "toolStep.updatePlan": "Update the plan",
  "toolStep.askHelper": "Hand a task to a helper",
  "toolStep.think": "Think",
  "toolStep.checkTeam": "Check the team",
  "toolStep.manageAutomations": "Manage automations",
  "toolStep.checkAutomations": "Check automations",
  "toolStep.useTool": "Use a tool",
  "toolStep.usingWhose": "using {person}'s {app}",
  "chat.notice.signIn": "Sign in",
  "chat.notice.signInHint": "Open AI settings to sign in again",
  "chat.run.worked": "Worked",
  "chat.run.workedFor": "Worked for {elapsed}",
  "chat.run.steps": "{count} steps · {tools}",
  "chat.run.showSteps": "Show every step",
  "chat.run.more": "+{count} more",
  "place.cloud": "Cloud desktop",
  "place.vm": "Private desktop",
  "place.local": "This computer",
  "place.browser": "Browser",
  "place.auto": "Auto",
  "place.off": "Off",
  "place.chipTitle": "Where this conversation works",
  "place.chipAria": "Where this conversation works: {place}",
  "place.pinnedHere": "Pinned for this conversation",
  "place.fromBot": "From this bot's Works on setting",
  "place.live": "In use now",
  "place.busy": "Wait for the current turn to finish",
  "place.offHint": "Works on is Off for this bot. Change it in the Screen panel.",
  "place.followBot": "Follow this bot's setting",
  "place.followBotDetail": "Currently {place}",
  "place.autoDetail": "Picks the right place for each task",
  "place.unavailable": "Not available for this bot's model or setup",
  "place.pinnedNote": "This conversation is pinned to {place}. Change it from the composer.",
  "place.pinnedNoteSimple": "This chat is pinned to “{place}”.",
  "place.unpinSimple": "Use {place}",
  "place.view.auto.short": "Chooses for you",
  "place.view.auto.lineMyCloud":
    "Uses the built-in browser. In a chat, it starts its cloud desktop by itself when a task needs desktop apps.",
  "place.view.auto.lineDesktop":
    "Uses the built-in browser, a private desktop on this computer, or this computer's screen, whichever the task needs.",
  "place.view.auto.lineLinux":
    "Uses the built-in browser, or a running private desktop when a task needs one.",
  "place.view.autoTeam.short": "Shared",
  "place.view.autoTeam.line": "Uses {computer}, the cloud desktop this department shares.",
  "place.view.ccCannot.short": "Not with this model",
  "place.view.ccCannot.line":
    "{model} can't use a desktop. Choose a model that can, such as Claude or ChatGPT.",
  "place.view.ccToolsOff.short": "Not allowed",
  "place.view.ccToolsOff.line": "What {bot} can use doesn't include a desktop.",
  "place.view.ccSignIn.short": "Sign in first",
  "place.view.ccSignIn.line": "Sign in to {engine} first. {bot} uses it on its cloud desktop too.",
  "place.view.ccSignIn.lineMyCloud":
    "Sign in to {engine} in the Cloud first. {bot} uses it on its cloud desktop too.",
  "place.view.ccNew.short": "Ready",
  "place.view.ccNew.line":
    "{bot} gets its own cloud desktop from Boat the first time a task needs one. The first start takes about a minute.",
  "place.view.ccStarting.short": "Starting…",
  "place.view.ccStarting.line":
    "Starting {bot}'s cloud desktop. The first start takes about a minute.",
  "place.view.ccWaking.short": "Waking…",
  "place.view.ccWaking.line": "Waking {bot}'s cloud desktop. This takes a few seconds.",
  "place.view.ccOn.short": "On",
  "place.view.ccOn.line":
    "{bot}'s cloud desktop is on. It goes to sleep after 10 minutes without use.",
  "place.view.ccAsleep.short": "Asleep",
  "place.view.ccAsleep.line":
    "{bot}'s cloud desktop is asleep. It wakes in a few seconds when {bot} needs it.",
  "place.view.ccNoHours.short": "No hours left",
  "place.view.ccNoHours.line":
    "This month's {hours} cloud desktop hours are used up. They come back on 1 {month}.",
  "place.view.ccNoHours.lineUnknown": "This month's cloud desktop hours are used up.",
  "place.view.ccNoHours.lineTrial":
    "The free trial's cloud desktop hours are used up. The full allowance starts with the first payment.",
  "place.view.ccAtOnce.short": "In use",
  "place.view.ccAtOnce.lineOne": "Your {plan} plan includes 1 cloud desktop, and {holders} has it.",
  "place.view.ccAtOnce.lineMany":
    "Your {plan} plan includes {max} cloud desktops, and {holders} have them.",
  "place.view.ccAtOnce.lineUnknown": "All the cloud desktops your plan includes are in use.",
  "place.view.ccUnavailable.short": "Not available now",
  "place.view.ccUnavailable.line":
    "Cloud desktops can't start right now. It isn't anything you did.",
  "place.view.ccEnded.short": "Plan ended",
  "place.view.ccEnded.line": "Your MausBot Cloud plan has ended, so cloud desktops are off.",
  "place.view.ccNoStart.short": "Didn't start",
  "place.view.ccNoStart.line": "{bot}'s cloud desktop didn't start.",
  "place.view.ccClearing.short": "Clearing up",
  "place.view.ccClearing.line": "{bot}'s previous cloud desktop is still being removed.",
  "place.view.ccProvider.short": "Couldn't start",
  "place.view.ccProvider.line": "Your Boat account couldn't start {bot}'s cloud desktop: {words}",
  "place.view.ccOnMyCloud.short": "For Cloud bots",
  "place.view.ccOnMyCloud.line": "Cloud desktops from your plan work for Cloud bots for now.",
  "place.view.ccNeedsKey.short": "Connect Boat first",
  "place.view.ccNeedsKey.line":
    "Bots here can get their own cloud desktops from Boat, a paid service.",
  "place.view.vps.short": "Your own machine",
  "place.view.vps.line": "Uses your own Linux machine, connected over SSH.",
  "place.view.browser.short": "Only websites",
  "place.view.browser.line": "Only websites, in the built-in browser. No desktop apps or files.",
  "place.view.browserOff.short": "Switched off",
  "place.view.browserOff.line":
    "The bot's own browser is switched off, so it can't open web pages.",
  "place.view.browserCannot.short": "Not with this model",
  "place.view.browserCannot.line": "{model} can't use the built-in browser.",
  "place.view.local.short": "Your files and apps",
  "place.view.local.line": "{bot} can use your files and apps here.",
  "place.view.localUnavailable.short": "Can't use it yet",
  "place.view.localUnavailable.line": "{reason}",
  "place.view.vm.short": "Can't see your files",
  "place.view.vm.line": "A separate, sandboxed desktop. {bot} can't see your files there.",
  "place.view.vmCannot.short": "Not with this model",
  "place.view.vmCannot.line":
    "{model} can't use a private desktop. Choose a model that can, such as Claude or ChatGPT.",
  "place.view.placeFailed.short": "Didn't start",
  "place.view.placeFailed.line": "{cause}",
  "place.view.off.short": "No screen",
  "place.view.off.line":
    "{bot} has no screen. It can still chat and do anything that doesn't need one.",
  "place.action.chooseModel": "Choose a model",
  "place.action.openTools": "Change what {bot} can use",
  "place.action.signIn": "Sign in",
  "place.action.start": "Start it now",
  "place.action.wake": "Wake it now",
  "place.action.watch": "Watch",
  "place.action.seePlan": "See your plan",
  "place.action.manageComputers": "Manage cloud desktops",
  "place.action.tryAgain": "Try again",
  "place.action.openMyCloud": "Open the Cloud",
  "place.action.addBoatKey": "Connect Boat",
  "place.action.turnOnBrowser": "Turn on the browser",
  "place.action.openTeamMap": "Open Team map",
  "place.action.openVmSettings": "Private desktop settings",
  "place.action.clearPin": "Clear this conversation's place",
  "place.action.usePlace": "Use {place}",
  "place.action.changeRoutine": "Change where it runs",
  "place.action.openComputerPanel": "Open the Screen panel",
  "place.askAdmin": "Ask an Admin to change it.",
  "place.backOnAuto": "This conversation is back on Auto.",
  "chat.notice.restartInterrupted": "turn interrupted — OpenMausBot restarted",
  "chat.notice.resumingAfterRestart": "Resuming after a restart",
  "chat.notice.cutOffByRestart": "{name} was cut off by a restart; resuming",
  "chat.notice.stalled": "no activity for {minutes} minutes — the turn was stopped",
  "chat.notice.stalledCommand":
    "the command `{command}` ran for {minutes} minutes without finishing and looks stuck — the turn was stopped",
  "chat.notice.unattendedTooLong":
    "this turn had nobody waiting on it and worked for {minutes} minutes, its limit — the turn was stopped",
  "chat.notice.unattendedRequests":
    "this turn had nobody waiting on it and made {count} requests to its AI, its limit — the turn was stopped",
  "chat.notice.unattendedDenied":
    "this turn had nobody waiting on it and {count} of its permission requests were denied or went unanswered — the turn was stopped",
  "chat.notice.engineExited": "the process running this turn's AI ended — the turn was stopped",
  "chat.notice.followupInterrupted":
    "Queued follow-up interrupted by restart or restore — it may have already run. Review the result before sending it again.",
  "chat.notice.usageLimit":
    "This {provider} account has reached its usage limit{detail}. Wait for it to reset, or switch this bot to another AI.",
  "chat.notice.claudeExtraUsage":
    "Claude refused this turn because this model runs on extra usage for your account, and those credits are used up. Your plan's own usage is not affected: switch this bot to a model your plan includes, or add extra usage in your Claude account.",
  "chat.notice.claudeLimitResets":
    "This Claude account has reached its {limit}, which resets {resets}. Until then, {meanwhile}.",
  "chat.notice.claudeLimitSaid":
    'This Claude account has reached its {limit} (Claude says: "{said}"). For now, {meanwhile}.',
  "chat.notice.claudeLimit": "This Claude account has reached its {limit}. For now, {meanwhile}.",
  "chat.notice.part.fiveHourLimit": "5-hour limit",
  "chat.notice.part.weeklyLimit": "weekly limit",
  "chat.notice.part.weeklyOpusLimit": "weekly Opus limit",
  "chat.notice.part.weeklySonnetLimit": "weekly Sonnet limit",
  "chat.notice.part.usageLimit": "usage limit",
  "chat.notice.part.computerToolsTookTooLong": "they took too long to start",
  "chat.notice.part.computerToolsHelperStopped": "their helper stopped",
  "chat.notice.part.computerToolsHelperFailed": "their helper did not answer properly",
  "chat.notice.part.chooseModel": "choose another model for this bot",
  "chat.notice.part.switchAccount": "switch this bot to another AI or Claude account",
  "chat.notice.webhookHome":
    'I\'m back on this computer, so my webhook "{name}" has an address here again. Open Automations, choose Copy address on "{name}", and paste it into the app that sends to it.',
  "routines.server.checksFailed": "The checks could not run; they try again at the next check.",
  "routines.server.nothingNew": "Nothing new since the last check",
  "routines.server.limitWait":
    "Waiting for the AI's usage limit to reset; this run starts again at {resets}",
  "routines.server.retryAfter": "Starting again shortly after {why}: {failure}",
  "routines.server.retryAfterRestart":
    "Starting again shortly after OpenMausBot restarted while it ran",
  "routines.server.backupAi":
    "Starting again on the backup AI: this bot's AI reached its usage limit",
  "routines.server.waitingToStart": "Waiting to start: {failure}",
  "routines.server.stillBusy": "Did not start: still busy after {minutes} minutes ({failure})",
  "routines.server.failedAfterRetry": "Failed after one automatic retry: {failure}",
  "routines.server.signedOut":
    "This bot's AI is signed out. Sign in again in Settings → AI. The AI said: “{failure}”",
  "routines.server.part.stalled": "the AI stalled",
  "routines.server.part.rateLimited": "a rate limit",
  "routines.server.part.provider": "a temporary error",
  "chat.narration.hide": "Hide progress messages",
  "chat.narration.show": "Show progress messages",
  "chat.notice.phone.notOwner": "not the owner's own turn",
  "chat.notice.phone.noPhone": "no phone paired with its apps allowed",
  "chat.notice.phone.allowed": "allowed {tool}",
  "chat.notice.phone.denied.calendar": "Calendar is not allowed on the phone",
  "chat.notice.phone.denied.reminders": "Reminders is not allowed on the phone",
  "chat.notice.phone.denied.contacts": "Contacts is not allowed on the phone",
  "chat.notice.phone.denied.location": "Location is not allowed on the phone",
  "chat.notice.phone.denied.home": "Home is not allowed on the phone",
  "chat.notice.phone.denied.messages": "Messages is not allowed on the phone",
  "chat.notice.phone.write.PHONE_CREATE_EVENT": "Create event on {phone}",
  "chat.notice.phone.write.PHONE_UPDATE_EVENT": "Update event on {phone}",
  "chat.notice.phone.write.PHONE_DELETE_EVENT": "Delete event on {phone}",
  "chat.notice.phone.write.PHONE_RESPOND_TO_INVITE": "Respond to invite on {phone}",
  "chat.notice.phone.write.PHONE_CREATE_REMINDER": "Create reminder on {phone}",
  "chat.notice.phone.write.PHONE_UPDATE_REMINDER": "Update reminder on {phone}",
  "chat.notice.phone.write.PHONE_COMPLETE_REMINDER": "Complete reminder on {phone}",
  "chat.notice.phone.write.PHONE_DELETE_REMINDER": "Delete reminder on {phone}",
  "chat.notice.phone.write.PHONE_CREATE_CONTACT": "Create contact on {phone}",
  "chat.notice.phone.write.PHONE_UPDATE_CONTACT": "Update contact on {phone}",
  "chat.notice.phone.write.PHONE_SET_ACCESSORY": "Set accessory on {phone}",
  "chat.notice.phone.write.PHONE_RUN_SCENE": "Run scene on {phone}",
  "chat.notice.phone.write.PHONE_SEND_MESSAGE": "Send message on {phone}",
  "chat.notice.phone.write.PHONE_SEND_WHATSAPP": "Send whatsapp on {phone}",
  "chat.notice.acpRestarted":
    "{provider} was restarted because a session sharing its process ignored Stop",
  "chat.notice.acpStopFailed": "{provider} ignored Stop and its process could not be ended",
  "chat.notice.toolCount":
    "{provider} refused this turn because this model takes at most {limit} tools and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.",
  "chat.notice.toolCountUnknown":
    "{provider} refused this turn because this model takes at most a limited number of tools and this bot offers more, even with its tool lists trimmed, so nothing ran. Turn off some of this bot's apps or MCP servers, or switch the bot to another model.",
  "chat.notice.modelNoRoute":
    "{provider} can't use the model {model} here, so choose another model for this bot.",
  "chat.notice.modelNoRouteUnnamed":
    "{provider} can't use this bot's model here, so choose another model for this bot.",
  "chat.notice.goalRetry": "{name}'s turn did not settle ({why}) — retrying once.",
  "chat.notice.part.providerFailed": "provider failed",
  "chat.notice.part.dispatchFailed": "dispatch failed",
  "chat.notice.part.goalStalled": "stalled",
  "chat.notice.part.goalTimedOut": "timed out",
  "chat.notice.goalWaiting":
    "{name} is finishing what it is doing. This goal will continue when it is free.",
  "chat.notice.goalBusyOne": "{name} stayed busy for {minutes} minute",
  "chat.notice.goalBusyMany": "{name} stayed busy for {minutes} minutes",
  "chat.notice.goalBusyOneAgain":
    "{name} stayed busy for {minutes} minute — send the goal again when they are free.",
  "chat.notice.goalBusyManyAgain":
    "{name} stayed busy for {minutes} minutes — send the goal again when they are free.",
  "chat.notice.goalWorking": "{name} is working on turn {turn} of {max}.",
  "chat.notice.goalEnded": "The goal run ended before the bot reported an outcome.",
  "chat.notice.teammateWorking": "Stopped here — {name} is still working; open to stop it too",
  "chat.notice.unknownTeammateWorking":
    "Stopped here — A teammate is still working; open to stop it too",
  "chat.notice.approve": "Approve: {what}",
  "chat.notice.exportedGoal.working": "{before}[Goal: working]{content}",
  "chat.notice.exportedGoal.completed": "{before}[Goal: completed]{content}",
  "chat.notice.exportedGoal.needs-input": "{before}[Goal: needs-input]{content}",
  "chat.notice.exportedGoal.blocked": "{before}[Goal: blocked]{content}",
  "chat.notice.exportedGoal.limit-reached": "{before}[Goal: limit-reached]{content}",
  "chat.notice.exportedGoal.paused": "{before}[Goal: paused]{content}",
  "chat.notice.exportedGoal.stopped": "{before}[Goal: stopped]{content}",
  "chat.notice.exportedGoal.failed": "{before}[Goal: failed]{content}",
  "routines.server.part.failed": "a failure",
  "chat.notice.acpEmpty": "{provider} finished without replying.",
  "chat.notice.acpNoReason": "{provider} stopped without saying why.",
  "chat.notice.acpMcpAppsFailed":
    "Connected apps couldn't be set up, so {provider} couldn't start this reply. Try again, or switch this bot to another AI.",
  "chat.notice.acpMcpServerFailed":
    "The \"{server}\" MCP server couldn't be set up, so {provider} couldn't start this reply. Try again, or switch this bot to another AI.",
  "chat.notice.stop.refusal":
    "{provider} refused to go on with this request (stop reason: {reason}). Try again, reword the request, or switch this bot to another AI.",
  "chat.notice.stop.refusalGeneric":
    "The AI refused to go on with this request (stop reason: {reason}). Try again, reword the request, or switch this bot to another AI.",
  "chat.notice.stop.maxTokens":
    "{provider}'s reply reached its maximum length before it finished (stop reason: {reason}). Ask it to continue, or ask for a shorter answer.",
  "chat.notice.stop.maxTokensGeneric":
    "The AI's reply reached its maximum length before it finished (stop reason: {reason}). Ask it to continue, or ask for a shorter answer.",
  "chat.notice.stop.maxRequests":
    "The turn made as many model requests as one turn may before it finished (stop reason: {reason}). Ask it to carry on from where it stopped, or split the task.",
  "chat.notice.unaskedStop":
    'The AI\'s request was cut off before it finished, and nobody stopped it (it said only "{said}"). Send the message again to try once more.',
  "chat.notice.piSessionSlow":
    "Pi is taking longer than usual to start this conversation's session. The turn goes on when Pi answers. Press Stop to cancel it.",
  "chat.notice.unreadMessage":
    "This turn ended before the model read a message sent while it ran. Send that message again.",
  "chat.notice.codexUnsupportedOne":
    'Codex could not run the tool {tools} ("unsupported call"): the AI provider sent the call back without the tool\'s app name, so it never reached the tool. Pick a model for this bot whose provider handles tool calls fully.',
  "chat.notice.codexUnsupportedMany":
    'Codex could not run the tools {tools} ("unsupported call"): the AI provider sent the call back without the tool\'s app name, so it never reached the tool. Pick a model for this bot whose provider handles tool calls fully.',
  "chat.notice.codexUnsupportedMore":
    'Codex could not run the tools {tools} and {count} more ("unsupported call"): the AI provider sent the call back without the tool\'s app name, so it never reached the tool. Pick a model for this bot whose provider handles tool calls fully.',
  "chat.notice.copilotAccountRefused":
    "GitHub Copilot refused this request for the signed-in account. Check its Copilot plan and premium request allowance, then try again.",
  "chat.notice.commandCodeAccountRefused":
    "Command Code refused this request for the signed-in account. Check its plan and credits on commandcode.ai, then try again.",
  "chat.notice.kiroAccountRefused":
    "Kiro refused this request for the signed-in account. Check its Kiro plan and credits, then try again.",
  "chat.notice.devinAccountRefused":
    "Devin refused this request for the signed-in account. Check its Devin plan and credits, then try again.",
  "chat.notice.acpQuietUsageLimit":
    "{name} reached a usage limit{said} and is waiting it out without replying, so this turn was stopped.",
  "chat.notice.acpQuietStuck":
    "{name} sent nothing for {quiet} with no tool running, no open request to its model and no CPU use, so the turn was stopped as stuck. Send the message again to retry.",
  "chat.notice.acpModelRequestFailed":
    '{name}\'s model request failed: "{message}" {name} may retry or stop; no reply for {quiet} so far.',
  "chat.notice.acpModelFallback":
    "{displayName} no longer offers {wanted}, so this conversation uses {fallback}. Choose another model for this bot to stop seeing this.",
  "chat.notice.codexActionMayHaveRun":
    "{message} A tool action may have run. Check its effects before trying again.",
  "chat.notice.modelServerStoppedAnswering":
    "The model server at {host} stopped answering, so the reply was stopped.",
  "chat.notice.piModelNotConfirmed": "Pi did not confirm the selected model",
  "chat.notice.waitingApprovalElsewhere": "Waiting on your approval in @{name}",
  "chat.notice.waitingAnswerElsewhere": "Waiting on your answer in @{name}",
  "chat.notice.teammateNeedsInput": "{name} needs your input: {question}",
  "chat.notice.relayCouldNotContinue": "this conversation could not carry on — {error}",
  "chat.notice.engineSignedOut": "{name} is signed out.",
  "chat.notice.failoverSignedInAgain":
    "{engine} is signed in again, so this conversation is back on {engine}.",
  "chat.notice.failoverSignedOut": "{from} is signed out, so {to} took over.",
  "chat.notice.backupCardWaiting":
    "switched to {name}. Your request waits on a card above and continues on {name} once you act on it.",
  "chat.notice.backupRequestUnderWay":
    "switched to {name}. Your request is still under way here and continues on {name}.",
  "chat.notice.backupConversationBusy":
    "switched to {name}. This conversation is working, so your message was not sent again.",
  "chat.notice.backupQuestionWaiting":
    "switched to {name}. A teammate's question is waiting for your answer in this conversation, so your message was not sent again. Answer it, then send your message again.",
  "chat.notice.backupMessageMissing":
    "switched to {name}, but your message could not be found to send again. Send it again.",
  "chat.notice.backupContinuingLimit": "continuing on {name} after hitting the usage limit",
  "chat.notice.backupContinuingSignedOut": "continuing on {name} while {engine} is signed out",
  "chat.notice.backupCouldNotContinue": "could not continue on {name}: {error}",
  "routines.server.backupSignedOut": "Starting again on the backup AI: this bot's AI is signed out",
  "routines.server.busyTooLong": "Did not run: the bot was busy for more than {minutes} minutes",
  "routines.server.overLimit": "Stopped: this run ran longer than the {hours}-hour limit",
  "routines.server.stopPending":
    "Its turn has not confirmed that it stopped. The next run waits for that, up to {minutes} minutes.",
  "routines.server.stopUnconfirmed":
    "Its turn never confirmed that it stopped, so the next run started without that.",
  "routines.server.skippedOne": "Skipped because {why}",
  "routines.server.skippedMany": "Skipped {count} scheduled runs because {why}",
  "routines.server.startSkippedOne": "Not run at this start because {why}",
  "routines.server.startSkippedMany": "Not run at {count} starts because {why}",
  "routines.server.part.stillWaiting": "the previous run of this routine is still waiting",
  "routines.server.part.stillRunning": "the previous run of this routine is still running",
  "routines.server.part.notStarted": "the previous run of this routine has not started yet",
  "routines.server.part.computerNoStart":
    "its cloud desktop has not started, so its next tries are spaced out",
  "routines.server.part.runsFailed": "its last runs failed, so its next tries are spaced out",
  "routines.server.part.restartedSoon":
    "OpenMausBot started again soon after the start that last ran it",
  "routines.server.missedOne": "Missed because {why}",
  "routines.server.missedMany": "Missed {count} scheduled runs because {why}",
  "routines.server.missedTooLate":
    "Missed because {why} until more than {hours} hours after its time",
  "routines.server.part.computerOff": "this computer was asleep or OpenMausBot was not running",
  "routines.server.part.cloudDown": "this Cloud was asleep or restarting",
  "routines.server.part.heldUp": "the scheduler was held up starting another run",
  "routines.server.restored":
    "Not run again: this schedule was restored from a backup made before this run had its turn",
  "routines.server.restoredMany":
    "Not run again: {count} scheduled runs from before this schedule was restored from a backup",
  "routines.server.duplicate": "Not started: this scheduled run had already started once",
  "routines.server.capSkippedOne":
    "Skipped: {why} ({amount}) is reached. Runs start again after {resets}",
  "routines.server.capSkippedMany":
    "Skipped {count} runs: {why} ({amount}) is reached. Runs start again after {resets}",
  "routines.server.part.capServerDay": "the daily usage cap for all bots",
  "routines.server.part.capServerMonth": "the monthly usage cap for all bots",
  "routines.server.part.capBotDay": "this bot’s daily usage cap",
  "routines.server.part.capBotMonth": "this bot’s monthly usage cap",
  "chat.notice.waitDone.urlContains": "{label}: done. {url} now says “{text}”.",
  "chat.notice.waitDone.urlMissing": "{label}: done. {url} no longer says “{text}”.",
  "chat.notice.waitDone.fileExists": "{label}: done. {path} is there now.",
  "chat.notice.waitDone.fileMissing": "{label}: done. {path} is gone.",
  "chat.notice.waitDone.fileChanged": "{label}: done. {path} changed.",
  "chat.notice.waitDone.processRunning": "{label}: done. {process} is running.",
  "chat.notice.waitDone.processGone": "{label}: done. {process} stopped.",
  "chat.notice.waitDone.botIdle": "{label}: done. {botName} finished.",
  "chat.notice.waitBotGone": "Stopped waiting for {label}: {botName} no longer exists.",
  "chat.notice.waitExpiredOne": "Stopped waiting for {label} after {hours} hour.",
  "chat.notice.waitExpiredMany": "Stopped waiting for {label} after {hours} hours.",
  "chat.notice.computerDesktopOnly":
    "Only the OpenMausBot app on this computer can let a bot use it. Open the app here, or let the bot work in its own browser or on a cloud desktop instead.",
  "chat.notice.computerPermissionsThenRestart":
    "OpenMausBot can't use this computer yet — make sure OpenMausBot has the permissions it asks for, then restart it",
  "chat.notice.computerNotReadyDetail": "OpenMausBot can't use this computer yet — {reason}",
  "chat.notice.computerToolsDidNotStart":
    "The tools for this computer did not start this time ({why}). Send your message again in a moment.",
  "chat.notice.computerToolsStillNotStarting":
    "The tools for this computer are still not starting.",
  "chat.notice.computerNotReadyMacPermission":
    "OpenMausBot can't use this computer yet — {reason}. Relaunch OpenMausBot after granting the missing macOS permission.",
  "chat.notice.computerSystemUnsupported":
    "bots can't use this computer on this system — choose another place for this bot to work",
  "chat.notice.computerAiUnsupported":
    "this bot's AI can't use this computer — pick another AI for this bot, or choose another place for it to work",
  "chat.notice.memoryReclaimedBrowser":
    "Ran out of room, so I closed the browser to keep everything else running.",
  "chat.notice.memoryReclaimedTask":
    "Ran out of room, so I stopped this task to keep everything else running.",
  "chat.notice.memoryReclaimedBrowserDetail":
    "Ran out of room, so I closed the browser to keep everything else running. ({detail})",
  "chat.notice.memoryReclaimedTaskDetail":
    "Ran out of room, so I stopped this task to keep everything else running. ({detail})",
  "chat.notice.outOfProcesses":
    "There is no room to start another program ({code}), so this task could not run. Nothing was sent to the AI. It starts again by itself when there is room.",
  "chat.notice.elicitationUrlDeclined":
    "{server} asked you to open a link to continue. OpenMausBot can't open it from here, so the request was declined. Open the link yourself, then ask the bot to try again.",
  "chat.notice.elicitationUrlDeclinedWithUrl":
    "{server} asked you to open a link to continue: {url}. OpenMausBot can't open it from here, so the request was declined. Open the link yourself, then ask the bot to try again.",
  "chat.notice.elicitationUrlDeclinedGeneric":
    "An MCP server asked you to open a link to continue. OpenMausBot can't open it from here, so the request was declined. Open the link yourself, then ask the bot to try again.",
  "chat.notice.elicitationUrlDeclinedGenericWithUrl":
    "An MCP server asked you to open a link to continue: {url}. OpenMausBot can't open it from here, so the request was declined. Open the link yourself, then ask the bot to try again.",
  "chat.notice.elicitationFormDeclinedOne":
    "{server} asked you to fill in a field. OpenMausBot can't show that form yet, so the request was declined.",
  "chat.notice.elicitationFormDeclinedMany":
    "{server} asked you to fill in {fields} fields. OpenMausBot can't show that form yet, so the request was declined.",
  "chat.notice.elicitationFormDeclinedOneMessage":
    '{server} asked you to fill in a field ("{message}"). OpenMausBot can\'t show that form yet, so the request was declined.',
  "chat.notice.elicitationFormDeclinedManyMessage":
    '{server} asked you to fill in {fields} fields ("{message}"). OpenMausBot can\'t show that form yet, so the request was declined.',
  "chat.notice.elicitationFormDeclinedGenericOne":
    "An MCP server asked you to fill in a field. OpenMausBot can't show that form yet, so the request was declined.",
  "chat.notice.elicitationFormDeclinedGenericMany":
    "An MCP server asked you to fill in {fields} fields. OpenMausBot can't show that form yet, so the request was declined.",
  "chat.notice.elicitationFormDeclinedGenericOneMessage":
    'An MCP server asked you to fill in a field ("{message}"). OpenMausBot can\'t show that form yet, so the request was declined.',
  "chat.notice.elicitationFormDeclinedGenericManyMessage":
    'An MCP server asked you to fill in {fields} fields ("{message}"). OpenMausBot can\'t show that form yet, so the request was declined.',
  "chat.notice.elicitationContinue": "{server} asks to continue",
  "chat.notice.elicitationContinueGeneric": "An MCP server asks to continue",
  "chat.notice.elicitationMessageGeneric": "An MCP server: {message}",
  "chat.notice.appAccessRequested": "App access requested",
  "chat.notice.codexModelUnavailable":
    "This model isn't available on your ChatGPT plan, so it's now hidden from this account's model list. Pick another model.",
  "chat.notice.codexElicitationDeclined":
    "{server} asked for input OpenMausBot can't show yet, so the request was declined.",
  "chat.notice.codexElicitationDeclinedGeneric":
    "An MCP server asked for input OpenMausBot can't show yet, so the request was declined.",
  "chat.notice.usageLimitResets":
    "This {provider} account has reached its usage limit{detail}, which resets {resets}. Until then, switch this bot to another AI.",
} as const;
export type LocaleKey = keyof typeof en;
export type LocalePack = Partial<Record<LocaleKey, string>>;
export const locales: Readonly<Record<string, LocalePack>> = {
  en,
  zh: {
    "chat.messageActions": "消息操作",
    "sidebar.searchClose": "关闭搜索",
    "task.updated.justNow": "刚刚",
    "task.updated.minutes": "{count} 分钟前",
    "task.updated.hours": "{count} 小时前",
    "task.updated.yesterday": "昨天",
    "task.updated.days": "{count} 天前",
    "chat.reply.replyingTo": "回复 {name}",
    "chat.reply.jump": "跳到原消息",
    "chat.reply.cancel": "取消回复",
    "chat.copyLink": "复制链接",
    "chat.showFull": "显示完整消息",
    "chat.showLess": "收起",
    "chat.spoiler.reveal": "揭示剧透内容",
    "chat.spoiler.hide": "隐藏剧透内容",
    "chat.spoiler.hideShort": "隐藏",
    "code.copyTitle": "复制代码",
    "code.copiedTitle": "已复制到剪贴板",
    "code.wrapLines": "自动换行",
    "common.copyFailed": "无法复制",
    "chat.more": "更多",
    "code.saveAsFile": "另存为文件",
    "question.showFull": "显示完整问题",
    "question.showLess": "收起",
    "toolDetail.label": "{name} · {status} · 工具详细信息",
    "toolDetail.input": "输入",
    "toolDetail.output": "结果",
    "toolDetail.running": "运行中",
    "toolDetail.failed": "失败",
    "toolDetail.completed": "已完成",
    "toolDetail.unverified": "没有结果",
    "toolDetail.waiting": "正在等待工具完成…",
    "toolDetail.noOutput": "这次调用没有记录任何输出。",
    "toolDetail.loadingFull": "正在加载完整结果…",
    "toolDetail.partial": "仅显示结果开头部分：无法加载其余内容。",
    "toolDetail.previewHint": "工具输入与输出记录，分享前请先检查。",
    "toolDetail.tool": "工具",
    "toolStep.runCommand": "运行命令",
    "toolStep.readFile": "读取文件",
    "toolStep.writeFile": "写入文件",
    "toolStep.editFile": "编辑文件",
    "toolStep.deleteFile": "删除文件",
    "toolStep.searchFiles": "搜索文件",
    "toolStep.searchWeb": "搜索网络",
    "toolStep.openWebPage": "打开网页",
    "toolStep.lookAtScreen": "查看屏幕",
    "toolStep.useComputer": "操作屏幕",
    "toolStep.useBrowser": "使用浏览器",
    "toolStep.updatePlan": "更新计划",
    "toolStep.askHelper": "把任务交给帮手",
    "toolStep.think": "思考",
    "toolStep.checkTeam": "查看团队",
    "toolStep.manageAutomations": "管理自动化",
    "toolStep.checkAutomations": "查看自动化",
    "toolStep.useTool": "使用工具",
    "toolStep.usingWhose": "正在使用 {person} 的 {app}",
    "chat.notice.signIn": "登录",
    "chat.notice.signInHint": "打开 AI 设置以重新登录",
    "chat.run.worked": "已工作",
    "chat.run.workedFor": "已工作 {elapsed}",
    "chat.run.steps": "{count} 步 · {tools}",
    "chat.run.showSteps": "显示每一步",
    "chat.run.more": "另外 {count} 个",
    "place.cloud": "云端桌面",
    "place.vm": "私有桌面",
    "place.local": "这台电脑",
    "place.browser": "浏览器",
    "place.auto": "自动",
    "place.off": "关闭",
    "place.chipTitle": "此对话的运行位置",
    "place.chipAria": "此对话的运行位置：{place}",
    "place.pinnedHere": "已为此对话固定",
    "place.fromBot": "依照此机器人的「运行位置」设置",
    "place.live": "正在使用",
    "place.busy": "请等目前回合完成",
    "place.offHint": "此机器人的「运行位置」已关闭。请在「屏幕」面板中变更。",
    "place.followBot": "依照此机器人的设置",
    "place.followBotDetail": "目前为 {place}",
    "place.autoDetail": "为每项任务挑选合适的位置",
    "place.unavailable": "此机器人的模型或设置不支持",
    "place.pinnedNote": "此对话已固定在 {place}。请从输入区更改。",
    "place.pinnedNoteSimple": "此聊天已固定到「{place}」。",
    "place.unpinSimple": "使用 {place}",
    "place.view.auto.short": "自动为你选择",
    "place.view.auto.lineMyCloud":
      "使用内置浏览器。在对话中，如果任务需要桌面应用，它会自行启动自己的云端桌面。",
    "place.view.auto.lineDesktop":
      "按任务需要，使用内置浏览器、这台电脑上的私有桌面或这台电脑的屏幕。",
    "place.view.auto.lineLinux": "使用内置浏览器；任务需要时，则使用正在运行的私有桌面。",
    "place.view.autoTeam.short": "共享",
    "place.view.autoTeam.line": "使用 {computer}，也就是这个部门共享的云端桌面。",
    "place.view.ccCannot.short": "此模型不支持",
    "place.view.ccCannot.line": "{model} 无法使用桌面。请选择支持的模型，例如 Claude 或 ChatGPT。",
    "place.view.ccToolsOff.short": "未允许",
    "place.view.ccToolsOff.line": "{bot} 可使用的内容不包括桌面。",
    "place.view.ccSignIn.short": "请先登录",
    "place.view.ccSignIn.line": "请先登录 {engine}。{bot} 在它的云端桌面上也会使用它。",
    "place.view.ccSignIn.lineMyCloud":
      "请先在 Cloud 上登录 {engine}。{bot} 在它的云端桌面上也会使用它。",
    "place.view.ccNew.short": "就绪",
    "place.view.ccNew.line":
      "任务第一次需要时，{bot} 会获得自己的 Boat 云端桌面。首次启动大约需要一分钟。",
    "place.view.ccStarting.short": "正在启动…",
    "place.view.ccStarting.line": "正在启动 {bot} 的云端桌面。首次启动大约需要一分钟。",
    "place.view.ccWaking.short": "正在唤醒…",
    "place.view.ccWaking.line": "正在唤醒 {bot} 的云端桌面，这需要几秒钟。",
    "place.view.ccOn.short": "已开启",
    "place.view.ccOn.line": "{bot} 的云端桌面已开启。闲置 10 分钟后会进入休眠。",
    "place.view.ccAsleep.short": "休眠中",
    "place.view.ccAsleep.line": "{bot} 的云端桌面正在休眠。{bot} 需要时，它会在几秒内唤醒。",
    "place.view.ccNoHours.short": "时长已用完",
    "place.view.ccNoHours.line": "本月的 {hours} 小时云端桌面时长已用完，将于 {month} 1 日恢复。",
    "place.view.ccNoHours.lineUnknown": "本月的云端桌面时长已用完。",
    "place.view.ccNoHours.lineTrial": "免费试用的云端桌面时长已用完。完整额度从第一次付款开始。",
    "place.view.ccAtOnce.short": "正在使用",
    "place.view.ccAtOnce.lineOne": "你的 {plan} 方案包含 1 台云端桌面，目前由 {holders} 使用。",
    "place.view.ccAtOnce.lineMany":
      "你的 {plan} 方案包含 {max} 台云端桌面，目前由 {holders} 使用。",
    "place.view.ccAtOnce.lineUnknown": "你的方案包含的云端桌面都在使用中。",
    "place.view.ccUnavailable.short": "当前不可用",
    "place.view.ccUnavailable.line": "云端桌面目前无法启动，这不是你的操作导致的。",
    "place.view.ccEnded.short": "方案已结束",
    "place.view.ccEnded.line": "你的 MausBot Cloud 方案已结束，因此云端桌面已关闭。",
    "place.view.ccNoStart.short": "未能启动",
    "place.view.ccNoStart.line": "{bot} 的云端桌面未能启动。",
    "place.view.ccClearing.short": "正在清理",
    "place.view.ccClearing.line": "仍在移除 {bot} 之前的云端桌面。",
    "place.view.ccProvider.short": "无法启动",
    "place.view.ccProvider.line": "你的 Boat 账户无法启动 {bot} 的云端桌面：{words}",
    "place.view.ccOnMyCloud.short": "仅限 Cloud 上的机器人",
    "place.view.ccOnMyCloud.line": "目前方案包含的云端桌面仅适用于 Cloud 上的机器人。",
    "place.view.ccNeedsKey.short": "请先连接 Boat",
    "place.view.ccNeedsKey.line": "这里的机器人可以使用付费服务 Boat 提供的专属云端桌面。",
    "place.view.vps.short": "你自己的机器",
    "place.view.vps.line": "使用你自己的 Linux 机器，通过 SSH 连接。",
    "place.view.browserOff.short": "已关闭",
    "place.view.browserOff.line": "机器人自己的浏览器已关闭，因此无法打开网页。",
    "place.view.browserCannot.short": "此模型不支持",
    "place.view.browserCannot.line": "{model} 无法使用内置浏览器。",
    "place.view.localUnavailable.short": "暂时还不能使用",
    "place.view.localUnavailable.line": "{reason}",
    "place.view.vmCannot.short": "此模型不支持",
    "place.view.vmCannot.line":
      "{model} 无法使用私有桌面。请选择支持的模型，例如 Claude 或 ChatGPT。",
    "place.view.placeFailed.short": "未能启动",
    "place.view.placeFailed.line": "{cause}",
    "place.view.off.short": "无屏幕",
    "place.view.off.line": "{bot} 没有屏幕。它仍可聊天，也能处理任何不需要屏幕的工作。",
    "place.action.chooseModel": "选择模型",
    "place.action.openTools": "更改 {bot} 可用的内容",
    "place.action.signIn": "登录",
    "place.action.start": "立即启动",
    "place.action.wake": "立即唤醒",
    "place.action.watch": "观看",
    "place.action.seePlan": "查看你的方案",
    "place.action.manageComputers": "管理云端桌面",
    "place.action.tryAgain": "重试",
    "place.action.openMyCloud": "打开 Cloud",
    "place.action.addBoatKey": "连接 Boat",
    "place.action.turnOnBrowser": "开启浏览器",
    "place.action.openTeamMap": "打开团队地图",
    "place.action.openVmSettings": "私有桌面设置",
    "place.action.clearPin": "清除此对话的位置",
    "place.action.usePlace": "使用 {place}",
    "place.action.changeRoutine": "更改运行位置",
    "place.action.openComputerPanel": "打开「屏幕」面板",
    "place.askAdmin": "请联系管理员更改。",
    "place.backOnAuto": "此对话已恢复为「自动」。",
    "chat.notice.copilotAccountRefused":
      "GitHub Copilot 拒绝为这个已登录账号处理请求。请检查它的 Copilot 方案和高级请求额度，然后重试。",
    "chat.notice.devinAccountRefused":
      "Devin 拒绝了已登录账号的这个请求。请检查它的 Devin 套餐和额度，然后再试一次。",
    "chat.notice.acpQuietUsageLimit":
      "{name} 达到了使用上限{said}，正在不作回复地等待它重置，所以这个轮次已停止。",
    "chat.notice.acpQuietStuck":
      "{name} 在 {quiet} 内什么都没发送，也没有工具在运行、没有向模型发起的未完成请求、没有 CPU 占用，所以这个轮次被当作卡住而停止。请重新发送消息以重试。",
    "chat.notice.acpModelRequestFailed":
      "{name} 的模型请求失败：“{message}” {name} 可能会重试或停止；到目前为止已 {quiet} 没有回复。",
    "chat.notice.acpModelFallback":
      "{displayName} 已不再提供 {wanted}，所以这个对话改用 {fallback}。为这个机器人另选一个模型即可不再看到这条提示。",
    "chat.notice.codexActionMayHaveRun":
      "{message} 可能有工具操作已经执行过。重试之前请先检查它造成的影响。",
    "chat.notice.modelServerStoppedAnswering":
      "{host} 上的模型服务器停止了响应，所以回复被中止了。",
    "chat.notice.piModelNotConfirmed": "Pi 没有确认所选的模型",
    "chat.notice.waitingApprovalElsewhere": "正在等你在 @{name} 里批准",
    "chat.notice.waitingAnswerElsewhere": "正在等你在 @{name} 里回答",
    "chat.notice.teammateNeedsInput": "{name} 需要你的输入：{question}",
    "chat.notice.relayCouldNotContinue": "这个对话无法继续——{error}",
    "chat.notice.engineSignedOut": "{name} 已退出登录。",
    "chat.notice.failoverSignedInAgain": "{engine} 已重新登录，所以这个对话回到了 {engine}。",
    "chat.notice.failoverSignedOut": "{from} 已退出登录，所以改由 {to} 接手。",
    "chat.notice.backupCardWaiting":
      "已切换到 {name}。你的请求正在等上方的卡片，你操作后会在 {name} 上继续。",
    "chat.notice.backupRequestUnderWay":
      "已切换到 {name}。你的请求在这里仍在进行，并会在 {name} 上继续。",
    "chat.notice.backupConversationBusy":
      "已切换到 {name}。这个对话正在工作，所以你的消息没有重新发送。",
    "chat.notice.backupQuestionWaiting":
      "已切换到 {name}。有队友的问题正在这个对话里等你的回答，所以你的消息没有重新发送。请先回答它，再重新发送你的消息。",
    "chat.notice.backupMessageMissing":
      "已切换到 {name}，但找不到你的消息，无法重新发送。请重新发送。",
    "chat.notice.backupContinuingLimit": "达到使用上限后改在 {name} 上继续",
    "chat.notice.backupContinuingSignedOut": "在 {engine} 退出登录期间改在 {name} 上继续",
    "chat.notice.backupCouldNotContinue": "无法在 {name} 上继续：{error}",
    "routines.server.backupSignedOut": "正在改用备用 AI 重新开始：这个机器人的 AI 已退出登录",
    "routines.server.busyTooLong": "没有运行：机器人忙碌超过了 {minutes} 分钟",
    "routines.server.overLimit": "已停止：这次运行超过了 {hours} 小时的上限",
    "routines.server.stopPending":
      "它的回合还没有确认已停止。下一次运行会等待确认，最多 {minutes} 分钟。",
    "routines.server.stopUnconfirmed":
      "它的回合始终没有确认已停止，所以下一次运行没有等到确认就开始了。",
    "routines.server.skippedOne": "已跳过，因为{why}",
    "routines.server.skippedMany": "已跳过 {count} 次调度运行，因为{why}",
    "routines.server.part.stillWaiting": "这个例行任务的上一次运行仍在等待",
    "routines.server.part.stillRunning": "这个例行任务的上一次运行仍在进行",
    "routines.server.part.notStarted": "这个例行任务的上一次运行还没有开始",
    "routines.server.part.computerNoStart": "它的云端桌面未能启动，所以之后的尝试会隔得更久",
    "routines.server.missedOne": "没有运行，因为{why}",
    "routines.server.missedMany": "有 {count} 次调度运行没有运行，因为{why}",
    "routines.server.missedTooLate": "没有运行，因为{why}，直到超过预定时间 {hours} 小时",
    "routines.server.part.computerOff": "这台电脑处于睡眠状态，或 OpenMausBot 没有运行",
    "routines.server.part.cloudDown": "这个 Cloud 正在休眠或重启",
    "routines.server.part.heldUp": "调度器在启动另一次运行时被耽搁了",
    "routines.server.restored": "没有再次运行：这个日程是从备份恢复的，而备份早于这次运行",
    "routines.server.restoredMany": "没有再次运行：{count} 次调度运行发生在这个日程从备份恢复之前",
    "routines.server.duplicate": "没有启动：这次调度运行已经启动过一次",
    "chat.notice.waitDone.urlContains": "{label}：完成。{url} 现在显示“{text}”。",
    "chat.notice.waitDone.urlMissing": "{label}：完成。{url} 不再显示“{text}”。",
    "chat.notice.waitDone.fileExists": "{label}：完成。{path} 已经在那里了。",
    "chat.notice.waitDone.fileMissing": "{label}：完成。{path} 已经不在了。",
    "chat.notice.waitDone.fileChanged": "{label}：完成。{path} 有变化。",
    "chat.notice.waitDone.processRunning": "{label}：完成。{process} 正在运行。",
    "chat.notice.waitDone.processGone": "{label}：完成。{process} 已停止。",
    "chat.notice.waitDone.botIdle": "{label}：完成。{botName} 已完成。",
    "chat.notice.waitBotGone": "已停止等待 {label}：{botName} 已不存在。",
    "chat.notice.waitExpiredOne": "等待 {label} 已超过 {hours} 小时，已停止。",
    "chat.notice.waitExpiredMany": "等待 {label} 已超过 {hours} 小时，已停止。",
    "chat.notice.computerDesktopOnly":
      "只有这台电脑上的 OpenMausBot 应用能让机器人使用它。请在这里打开应用，或者让机器人在自己的浏览器或云电脑上工作。",
    "chat.notice.computerPermissionsThenRestart":
      "OpenMausBot 还无法使用这台电脑——请确认它已获得所请求的权限，然后重启它",
    "chat.notice.computerNotReadyDetail": "OpenMausBot 还无法使用这台电脑——{reason}",
    "chat.notice.computerNotReadyMacPermission":
      "OpenMausBot 还无法使用这台电脑——{reason}。授予缺少的 macOS 权限后请重新启动 OpenMausBot。",
    "chat.notice.computerSystemUnsupported":
      "在这个系统上机器人无法使用这台电脑——请为这个机器人另选一个工作位置",
    "chat.notice.computerAiUnsupported":
      "这个机器人的 AI 无法使用这台电脑——请为这个机器人另选一个 AI，或为它另选一个工作位置",
    "chat.notice.memoryReclaimedBrowser":
      "空间不够了，所以我关掉了浏览器，以保证其他一切继续运行。",
    "chat.notice.memoryReclaimedTask": "空间不够了，所以我停止了这项任务，以保证其他一切继续运行。",
    "chat.notice.memoryReclaimedBrowserDetail":
      "空间不够了，所以我关掉了浏览器，以保证其他一切继续运行。（{detail}）",
    "chat.notice.memoryReclaimedTaskDetail":
      "空间不够了，所以我停止了这项任务，以保证其他一切继续运行。（{detail}）",
    "chat.notice.elicitationUrlDeclined":
      "{server} 请你打开一个链接来继续。OpenMausBot 无法从这里打开它，所以该请求被拒绝了。请自己打开链接，然后让机器人重试。",
    "chat.notice.elicitationUrlDeclinedWithUrl":
      "{server} 请你打开一个链接来继续：{url}。OpenMausBot 无法从这里打开它，所以该请求被拒绝了。请自己打开链接，然后让机器人重试。",
    "chat.notice.elicitationUrlDeclinedGeneric":
      "有一个 MCP 服务请你打开一个链接来继续。OpenMausBot 无法从这里打开它，所以该请求被拒绝了。请自己打开链接，然后让机器人重试。",
    "chat.notice.elicitationUrlDeclinedGenericWithUrl":
      "有一个 MCP 服务请你打开一个链接来继续：{url}。OpenMausBot 无法从这里打开它，所以该请求被拒绝了。请自己打开链接，然后让机器人重试。",
    "chat.notice.elicitationFormDeclinedOne":
      "{server} 请你填写一个字段。OpenMausBot 还无法显示该表单，所以请求被拒绝了。",
    "chat.notice.elicitationFormDeclinedMany":
      "{server} 请你填写 {fields} 个字段。OpenMausBot 还无法显示该表单，所以请求被拒绝了。",
    "chat.notice.elicitationFormDeclinedOneMessage":
      "{server} 请你填写一个字段（“{message}”）。OpenMausBot 还无法显示该表单，所以请求被拒绝了。",
    "chat.notice.elicitationFormDeclinedManyMessage":
      "{server} 请你填写 {fields} 个字段（“{message}”）。OpenMausBot 还无法显示该表单，所以请求被拒绝了。",
    "chat.notice.elicitationFormDeclinedGenericOne":
      "有一个 MCP 服务请你填写一个字段。OpenMausBot 还无法显示该表单，所以请求被拒绝了。",
    "chat.notice.elicitationFormDeclinedGenericMany":
      "有一个 MCP 服务请你填写 {fields} 个字段。OpenMausBot 还无法显示该表单，所以请求被拒绝了。",
    "chat.notice.elicitationFormDeclinedGenericOneMessage":
      "有一个 MCP 服务请你填写一个字段（“{message}”）。OpenMausBot 还无法显示该表单，所以请求被拒绝了。",
    "chat.notice.elicitationFormDeclinedGenericManyMessage":
      "有一个 MCP 服务请你填写 {fields} 个字段（“{message}”）。OpenMausBot 还无法显示该表单，所以请求被拒绝了。",
    "chat.notice.elicitationContinue": "{server} 请求继续",
    "chat.notice.elicitationContinueGeneric": "有一个 MCP 服务请求继续",
    "chat.notice.elicitationMessageGeneric": "MCP 服务：{message}",
    "chat.notice.appAccessRequested": "请求应用访问权限",
    "chat.notice.codexModelUnavailable":
      "这个模型在你的 ChatGPT 方案中不可用，因此已从这个账号的模型列表中隐藏。请另选一个模型。",
    "chat.notice.codexElicitationDeclined":
      "{server} 请求了 OpenMausBot 还无法显示的输入，所以请求被拒绝了。",
    "chat.notice.codexElicitationDeclinedGeneric":
      "有一个 MCP 服务请求了 OpenMausBot 还无法显示的输入，所以请求被拒绝了。",
    "chat.notice.usageLimitResets":
      "这个 {provider} 账号已达到使用上限{detail}，将在{resets}重置。在那之前，请把这个机器人切换到别的 AI。",
    "chat.notice.phone.notOwner": "不是所有者自己的轮次",
    "chat.notice.phone.noPhone": "没有与它的应用配对的手机",
    "chat.notice.phone.allowed": "已允许 {tool}",
    "chat.notice.phone.denied.calendar": "手机上不允许使用日历",
    "chat.notice.phone.denied.reminders": "手机上不允许使用提醒事项",
    "chat.notice.phone.denied.contacts": "手机上不允许使用通讯录",
    "chat.notice.phone.denied.location": "手机上不允许使用位置",
    "chat.notice.phone.denied.home": "手机上不允许使用家庭",
    "chat.notice.phone.denied.messages": "手机上不允许使用信息",
    "chat.notice.phone.write.PHONE_CREATE_EVENT": "在 {phone} 上创建日程",
    "chat.notice.phone.write.PHONE_UPDATE_EVENT": "更新 {phone} 上的日程",
    "chat.notice.phone.write.PHONE_DELETE_EVENT": "删除 {phone} 上的日程",
    "chat.notice.phone.write.PHONE_RESPOND_TO_INVITE": "在 {phone} 上回复邀请",
    "chat.notice.phone.write.PHONE_CREATE_REMINDER": "在 {phone} 上创建提醒事项",
    "chat.notice.phone.write.PHONE_UPDATE_REMINDER": "更新 {phone} 上的提醒事项",
    "chat.notice.phone.write.PHONE_COMPLETE_REMINDER": "完成 {phone} 上的提醒事项",
    "chat.notice.phone.write.PHONE_DELETE_REMINDER": "删除 {phone} 上的提醒事项",
    "chat.notice.phone.write.PHONE_CREATE_CONTACT": "在 {phone} 上创建联系人",
    "chat.notice.phone.write.PHONE_UPDATE_CONTACT": "更新 {phone} 上的联系人",
    "chat.notice.phone.write.PHONE_SET_ACCESSORY": "在 {phone} 上设置配件",
    "chat.notice.phone.write.PHONE_RUN_SCENE": "在 {phone} 上运行场景",
    "chat.notice.phone.write.PHONE_SEND_MESSAGE": "在 {phone} 上发送信息",
    "chat.notice.phone.write.PHONE_SEND_WHATSAPP": "在 {phone} 上发送 WhatsApp",
    "chat.notice.acpRestarted": "{provider} 已重启，因为与它共用进程的会话忽略了停止请求",
    "chat.notice.acpStopFailed": "{provider} 忽略了停止请求，而且它的进程无法结束",
    "chat.notice.toolCount":
      "{provider} 拒绝了这个轮次，因为这个模型最多接受 {limit} 个工具，而这个机器人提供的更多——即使精简了工具列表也还是更多，所以什么也没运行。请关掉这个机器人的一些应用或 MCP 服务，或把机器人切换到别的模型。",
    "chat.notice.toolCountUnknown":
      "{provider} 拒绝了这个轮次，因为这个模型能接受的工具数量有限，而这个机器人提供的更多——即使精简了工具列表也还是更多，所以什么也没运行。请关掉这个机器人的一些应用或 MCP 服务，或把机器人切换到别的模型。",
    "chat.notice.goalRetry": "{name} 的轮次没有正常结束（{why}）——正在重试一次。",
    "chat.notice.part.providerFailed": "模型提供方失败",
    "chat.notice.part.dispatchFailed": "派发失败",
    "chat.notice.part.goalStalled": "停滞",
    "chat.notice.part.goalTimedOut": "超时",
    "chat.notice.goalWaiting": "{name} 正在把手上的事做完。这个目标会在它空闲后继续。",
    "chat.notice.goalBusyOne": "{name} 忙了 {minutes} 分钟",
    "chat.notice.goalBusyMany": "{name} 忙了 {minutes} 分钟",
    "chat.notice.goalBusyOneAgain": "{name} 忙了 {minutes} 分钟——等它空闲后请重新发送这个目标。",
    "chat.notice.goalBusyManyAgain": "{name} 忙了 {minutes} 分钟——等它空闲后请重新发送这个目标。",
    "chat.notice.goalWorking": "{name} 正在执行第 {turn} 个轮次，共 {max} 个。",
    "chat.notice.goalEnded": "目标运行在机器人报告结果之前就结束了。",
    "chat.notice.teammateWorking": "已在此停止——{name} 仍在工作；打开以一并停止",
    "chat.notice.unknownTeammateWorking": "已在此停止——有队友仍在工作；打开以一并停止",
    "chat.notice.approve": "批准：{what}",
    "chat.notice.exportedGoal.working": "{before}[目标：进行中]{content}",
    "chat.notice.exportedGoal.completed": "{before}[目标：已完成]{content}",
    "chat.notice.exportedGoal.needs-input": "{before}[目标：需要输入]{content}",
    "chat.notice.exportedGoal.blocked": "{before}[目标：受阻]{content}",
    "chat.notice.exportedGoal.limit-reached": "{before}[目标：已达上限]{content}",
    "chat.notice.exportedGoal.paused": "{before}[目标：已暂停]{content}",
    "chat.notice.exportedGoal.stopped": "{before}[目标：已停止]{content}",
    "chat.notice.exportedGoal.failed": "{before}[目标：失败]{content}",
    "routines.server.part.failed": "失败",
    "chat.notice.acpEmpty": "{provider} 结束了，但没有回复。",
    "chat.notice.acpNoReason": "{provider} 停止了，没有说明原因。",
    "chat.notice.stop.refusal":
      "{provider} 拒绝继续处理这个请求（停止原因：{reason}）。请重试、换个说法，或把这个机器人切换到别的 AI。",
    "chat.notice.stop.refusalGeneric":
      "AI 拒绝继续处理这个请求（停止原因：{reason}）。请重试、换个说法，或把这个机器人切换到别的 AI。",
    "chat.notice.stop.maxTokens":
      "{provider} 的回复在写完之前就达到了最大长度（停止原因：{reason}）。请让它继续，或要求它给出更短的答案。",
    "chat.notice.stop.maxTokensGeneric":
      "AI 的回复在写完之前就达到了最大长度（停止原因：{reason}）。请让它继续，或要求它给出更短的答案。",
    "chat.notice.stop.maxRequests":
      "这个轮次在写完之前就达到了单个轮次允许的模型请求次数（停止原因：{reason}）。请让它从中断处继续，或把任务拆开。",
    "chat.notice.unaskedStop":
      "AI 的请求在完成之前被中断了，而且没有人停止它（它只说了“{said}”）。请重新发送这条消息再试一次。",
    "chat.notice.piSessionSlow":
      "Pi 启动这个对话的会话比平时慢。Pi 一旦回应，轮次就会继续。按“停止”可以取消。",
    "chat.notice.unreadMessage":
      "这个轮次在模型读到运行期间收到的消息之前就结束了。请重新发送那条消息。",
    "chat.notice.codexUnsupportedOne":
      "Codex 无法运行工具 {tools}（“不支持的调用”）：模型提供方返回调用时没有带上工具的应用名，所以它从未到达工具。请为这个机器人选择一个能完整处理工具调用的模型提供方。",
    "chat.notice.codexUnsupportedMany":
      "Codex 无法运行工具 {tools}（“不支持的调用”）：模型提供方返回调用时没有带上工具的应用名，所以它从未到达工具。请为这个机器人选择一个能完整处理工具调用的模型提供方。",
    "chat.notice.codexUnsupportedMore":
      "Codex 无法运行工具 {tools} 以及其他 {count} 个（“不支持的调用”）：模型提供方返回调用时没有带上工具的应用名，所以它从未到达工具。请为这个机器人选择一个能完整处理工具调用的模型提供方。",
    "chat.narration.hide": "隐藏进展消息",
    "chat.narration.show": "显示进展消息",
    "chat.notice.restartInterrupted": "轮次被中断——OpenMausBot 已重启",
    "chat.notice.resumingAfterRestart": "重启后继续",
    "chat.notice.cutOffByRestart": "{name} 因重启被打断；正在继续",
    "chat.notice.stalled": "{minutes} 分钟没有活动——该轮次已停止",
    "chat.notice.engineExited": "运行本轮 AI 的进程已结束，该轮次已停止",
    "chat.notice.followupInterrupted":
      "排队中的追问因重启或恢复而中断——它可能已经执行过。请先查看结果，再决定是否重新发送。",
    "chat.notice.usageLimit":
      "这个 {provider} 账号已达到使用上限{detail}。请等它重置，或把这个机器人切换到别的 AI。",
    "chat.notice.claudeExtraUsage":
      "Claude 拒绝了这个轮次，因为这个模型对你账号来说是走额外用量的，而那份额度已用完。你自己套餐的用量不受影响：请把这个机器人切换到套餐包含的模型，或在你的 Claude 账号里添加额外用量。",
    "chat.notice.claudeLimitResets":
      "这个 Claude 账号已达到{limit}，将在{resets}重置。在那之前，{meanwhile}。",
    "chat.notice.claudeLimitSaid":
      "这个 Claude 账号已达到{limit}（Claude 说：“{said}”）。目前请{meanwhile}。",
    "chat.notice.claudeLimit": "这个 Claude 账号已达到{limit}。目前请{meanwhile}。",
    "chat.notice.part.fiveHourLimit": "5 小时上限",
    "chat.notice.part.weeklyLimit": "每周上限",
    "chat.notice.part.weeklyOpusLimit": "每周 Opus 上限",
    "chat.notice.part.weeklySonnetLimit": "每周 Sonnet 上限",
    "chat.notice.part.usageLimit": "使用上限",
    "chat.notice.part.chooseModel": "为这个机器人另选一个模型",
    "chat.notice.part.switchAccount": "把这个机器人切换到别的 AI 或 Claude 账号",
    "chat.notice.webhookHome":
      "我回到了这台电脑，所以我的 webhook“{name}”在这里重新有了地址。请打开“自动化”，在“{name}”上选择“拷贝地址”，再粘贴到向它发送数据的应用里。",
    "routines.server.checksFailed": "检查项没能运行；下次检查时会再试。",
    "routines.server.nothingNew": "自上次检查以来没有新内容",
    "routines.server.limitWait": "正在等 AI 的使用上限重置；这次运行会在 {resets} 重新开始",
    "routines.server.retryAfter": "在 {why} 之后不久重新开始：{failure}",
    "routines.server.retryAfterRestart": "运行期间 OpenMausBot 重启了；很快会重新开始",
    "routines.server.backupAi": "正在改用备用 AI 重新开始：这个机器人的 AI 达到了使用上限",
    "routines.server.waitingToStart": "等待开始：{failure}",
    "routines.server.stillBusy": "没有开始：忙了 {minutes} 分钟后仍然忙碌（{failure}）",
    "routines.server.failedAfterRetry": "自动重试一次后仍然失败：{failure}",
    "routines.server.signedOut":
      "这个机器人的 AI 已退出登录。请在设置 → AI 中重新登录。AI 说：“{failure}”",
    "routines.server.part.stalled": "AI 停滞了",
    "routines.server.part.rateLimited": "频率限制",
    "routines.server.part.provider": "临时错误",
  },
  "pt-br": {
    "chat.messageActions": "Ações da mensagem",
    "sidebar.searchClose": "Fechar busca",
    "task.updated.justNow": "agora mesmo",
    "task.updated.minutes": "há {count} min",
    "task.updated.hours": "há {count} h",
    "task.updated.yesterday": "ontem",
    "task.updated.days": "há {count} d",
    "chat.reply.replyingTo": "Respondendo a {name}",
    "chat.reply.jump": "Ir para a mensagem original",
    "chat.reply.cancel": "Cancelar a resposta",
    "chat.copyLink": "Copiar link",
    "chat.showFull": "Ver a mensagem inteira",
    "chat.showLess": "Mostrar menos",
    "chat.spoiler.reveal": "Mostrar spoiler",
    "chat.spoiler.hide": "Ocultar spoiler",
    "chat.spoiler.hideShort": "Ocultar",
    "code.copyTitle": "Copiar código",
    "code.copiedTitle": "Copiado para a área de transferência",
    "code.wrapLines": "Quebrar linhas",
    "common.copyFailed": "Não foi possível copiar",
    "chat.more": "Mais",
    "code.saveAsFile": "Salvar como arquivo",
    "question.showFull": "Mostrar a pergunta completa",
    "question.showLess": "Mostrar menos",
    "toolDetail.label": "{name} · {status} · Detalhes da ferramenta",
    "toolDetail.input": "Entrada",
    "toolDetail.output": "Resultado",
    "toolDetail.running": "Em execução",
    "toolDetail.failed": "Falhou",
    "toolDetail.completed": "Concluído",
    "toolDetail.unverified": "Sem resultado",
    "toolDetail.waiting": "Aguardando a ferramenta terminar…",
    "toolDetail.noOutput": "Nenhuma saída foi registrada para esta chamada.",
    "toolDetail.loadingFull": "Carregando o resultado completo…",
    "toolDetail.partial": "Só o início do resultado aparece: não foi possível carregar o restante.",
    "toolDetail.previewHint":
      "Entrada e saída da ferramenta nesta sessão. Revise antes de compartilhar.",
    "toolDetail.tool": "Ferramenta",
    "toolStep.runCommand": "Executar um comando",
    "toolStep.readFile": "Ler um arquivo",
    "toolStep.writeFile": "Escrever um arquivo",
    "toolStep.editFile": "Editar um arquivo",
    "toolStep.deleteFile": "Excluir um arquivo",
    "toolStep.searchFiles": "Buscar arquivos",
    "toolStep.searchWeb": "Buscar na web",
    "toolStep.openWebPage": "Abrir uma página da web",
    "toolStep.lookAtScreen": "Olhar a tela",
    "toolStep.useComputer": "Usar a tela",
    "toolStep.useBrowser": "Usar o navegador",
    "toolStep.updatePlan": "Atualizar o plano",
    "toolStep.askHelper": "Passar uma tarefa a um ajudante",
    "toolStep.think": "Pensar",
    "toolStep.checkTeam": "Verificar a equipe",
    "toolStep.manageAutomations": "Gerenciar automações",
    "toolStep.checkAutomations": "Consultar automações",
    "toolStep.useTool": "Usar uma ferramenta",
    "toolStep.usingWhose": "usando {app} de {person}",
    "chat.notice.signIn": "Entrar",
    "chat.notice.signInHint": "Abrir as configurações de IA para entrar novamente",
    "chat.run.worked": "Trabalhou",
    "chat.run.workedFor": "Trabalhou por {elapsed}",
    "chat.run.steps": "Passos: {count} · {tools}",
    "chat.run.showSteps": "Ver todos os passos",
    "chat.run.more": "+{count}",
    "place.cloud": "Desktop na nuvem",
    "place.vm": "Desktop privado",
    "place.local": "Este computador",
    "place.browser": "Navegador",
    "place.auto": "Auto",
    "place.off": "Desligado",
    "place.chipTitle": "Onde o bot trabalha nesta conversa",
    "place.chipAria": "Onde o bot trabalha nesta conversa: {place}",
    "place.pinnedHere": "Fixado para esta conversa",
    "place.fromBot": "Da configuração “Trabalha em” deste bot",
    "place.live": "Em uso agora",
    "place.busy": "Espere a sessão atual terminar",
    "place.offHint": "“Trabalha em” está “Desligado” para este bot. Altere no painel Tela.",
    "place.followBot": "Seguir a configuração deste bot",
    "place.followBotDetail": "Atualmente: {place}",
    "place.autoDetail": "Escolhe o lugar certo para cada tarefa",
    "place.unavailable": "Indisponível para o modelo ou a configuração deste bot",
    "place.pinnedNote": "Esta conversa está fixada em {place}. Altere pelo campo de mensagem.",
    "place.pinnedNoteSimple": "Esta conversa está fixada em “{place}”.",
    "place.unpinSimple": "Usar {place}",
    "place.view.auto.short": "Escolhe por você",
    "place.view.auto.lineMyCloud":
      "Usa o navegador integrado. Em uma conversa, liga seu próprio desktop na nuvem automaticamente quando uma tarefa precisa de apps para computador.",
    "place.view.auto.lineDesktop":
      "Conforme a tarefa, usa o navegador integrado, um desktop privado neste computador ou a tela deste computador.",
    "place.view.auto.lineLinux":
      "Usa o navegador integrado ou um desktop privado em execução quando uma tarefa precisa de um.",
    "place.view.autoTeam.short": "Compartilhado",
    "place.view.autoTeam.line": "Usa {computer}, o desktop na nuvem que esta equipe compartilha.",
    "place.view.ccCannot.short": "Sem suporte neste modelo",
    "place.view.ccCannot.line":
      "{model} não consegue usar um desktop. Escolha um modelo que consiga, como Claude ou ChatGPT.",
    "place.view.ccToolsOff.short": "Não permitido",
    "place.view.ccToolsOff.line": "{bot} não tem permissão para usar um desktop.",
    "place.view.ccSignIn.short": "Entre primeiro",
    "place.view.ccSignIn.line":
      "Entre na sua conta de {engine} primeiro. {bot} também a usa no desktop na nuvem dele.",
    "place.view.ccSignIn.lineMyCloud":
      "Entre na sua conta de {engine} no Cloud primeiro. {bot} também a usa no desktop na nuvem dele.",
    "place.view.ccNew.short": "Pronto",
    "place.view.ccNew.line":
      "{bot} recebe seu próprio desktop na nuvem da Boat na primeira vez que uma tarefa precisar de um. A primeira inicialização leva cerca de um minuto.",
    "place.view.ccStarting.short": "Iniciando…",
    "place.view.ccStarting.line":
      "Iniciando o desktop na nuvem de {bot}. Na primeira vez, isso leva cerca de um minuto.",
    "place.view.ccWaking.short": "Acordando…",
    "place.view.ccWaking.line": "Acordando o desktop na nuvem de {bot}. Isso leva alguns segundos.",
    "place.view.ccOn.short": "Ligado",
    "place.view.ccOn.line":
      "O desktop na nuvem de {bot} está ligado. Ele dorme após 10 minutos sem uso.",
    "place.view.ccAsleep.short": "Dormindo",
    "place.view.ccAsleep.line":
      "O desktop na nuvem de {bot} está dormindo. Ele acorda em alguns segundos quando {bot} precisar.",
    "place.view.ccNoHours.short": "Sem horas restantes",
    "place.view.ccNoHours.line":
      "As {hours} horas de desktop na nuvem deste mês acabaram. Elas voltam em 1º de {month}.",
    "place.view.ccNoHours.lineUnknown": "As horas de desktop na nuvem deste mês acabaram.",
    "place.view.ccNoHours.lineTrial":
      "As horas de desktop na nuvem do teste grátis acabaram. A franquia completa começa com o primeiro pagamento.",
    "place.view.ccAtOnce.short": "Em uso",
    "place.view.ccAtOnce.lineOne":
      "Seu plano {plan} inclui 1 desktop na nuvem, e {holders} está com ele.",
    "place.view.ccAtOnce.lineMany":
      "Seu plano {plan} inclui {max} desktops na nuvem, todos em uso por {holders}.",
    "place.view.ccAtOnce.lineUnknown":
      "Todos os desktops na nuvem incluídos no seu plano estão em uso.",
    "place.view.ccUnavailable.short": "Indisponível agora",
    "place.view.ccUnavailable.line":
      "Não é possível iniciar os desktops na nuvem agora. Não é culpa sua.",
    "place.view.ccEnded.short": "Plano encerrado",
    "place.view.ccEnded.line":
      "Seu plano do MausBot Cloud terminou, então os desktops na nuvem estão desligados.",
    "place.view.ccNoStart.short": "Não iniciou",
    "place.view.ccNoStart.line": "O desktop na nuvem de {bot} não iniciou.",
    "place.view.ccClearing.short": "Limpando",
    "place.view.ccClearing.line": "O desktop na nuvem anterior de {bot} ainda está sendo removido.",
    "place.view.ccProvider.short": "Não foi possível iniciar",
    "place.view.ccProvider.line":
      "Sua conta do Boat não conseguiu iniciar o desktop na nuvem de {bot}: {words}",
    "place.view.ccOnMyCloud.short": "Para bots do Cloud",
    "place.view.ccOnMyCloud.line":
      "Por enquanto, os desktops na nuvem do seu plano funcionam para os bots do Cloud.",
    "place.view.ccNeedsKey.short": "Conecte a Boat primeiro",
    "place.view.ccNeedsKey.line":
      "Os bots daqui podem ter seus próprios desktops na nuvem da Boat, um serviço pago.",
    "place.view.vps.short": "Sua própria máquina",
    "place.view.vps.line": "Usa sua própria máquina Linux, conectada por SSH.",
    "place.view.browser.short": "Só sites",
    "place.view.browser.line":
      "Só sites, no navegador integrado. Sem apps do computador nem arquivos.",
    "place.view.browserOff.short": "Desligado",
    "place.view.browserOff.line":
      "O navegador do bot está desligado, por isso ele não consegue abrir páginas da internet.",
    "place.view.browserCannot.short": "Sem suporte neste modelo",
    "place.view.browserCannot.line": "{model} não consegue usar o navegador integrado.",
    "place.view.local.short": "Seus arquivos e apps",
    "place.view.local.line": "{bot} pode usar seus arquivos e apps aqui.",
    "place.view.localUnavailable.short": "Ainda não pode usar",
    "place.view.localUnavailable.line": "{reason}",
    "place.view.vm.short": "Não vê seus arquivos",
    "place.view.vm.line": "Um desktop separado e isolado. Lá, {bot} não vê seus arquivos.",
    "place.view.vmCannot.short": "Sem suporte neste modelo",
    "place.view.vmCannot.line":
      "{model} não consegue usar um desktop privado. Escolha um modelo que consiga, como Claude ou ChatGPT.",
    "place.view.placeFailed.short": "Não iniciou",
    "place.view.placeFailed.line": "{cause}",
    "place.view.off.short": "Sem tela",
    "place.view.off.line":
      "{bot} não tem tela. Ainda pode conversar e fazer tudo o que não precise de uma.",
    "place.action.chooseModel": "Escolher um modelo",
    "place.action.openTools": "Mudar o que {bot} pode usar",
    "place.action.signIn": "Entrar",
    "place.action.start": "Iniciar agora",
    "place.action.wake": "Acordar agora",
    "place.action.watch": "Assistir",
    "place.action.seePlan": "Ver seu plano",
    "place.action.manageComputers": "Gerenciar desktops na nuvem",
    "place.action.tryAgain": "Tentar novamente",
    "place.action.openMyCloud": "Abrir o Cloud",
    "place.action.addBoatKey": "Conectar Boat",
    "place.action.turnOnBrowser": "Ligar o navegador",
    "place.action.openTeamMap": "Abrir o Mapa da equipe",
    "place.action.openVmSettings": "Abrir configurações do desktop privado",
    "place.action.clearPin": "Desafixar o local desta conversa",
    "place.action.usePlace": "Usar {place}",
    "place.action.changeRoutine": "Alterar onde ela roda",
    "place.action.openComputerPanel": "Abrir o painel Tela",
    "place.askAdmin": "Peça a um Admin para alterar.",
    "place.backOnAuto": "Esta conversa voltou para Auto.",
    "chat.notice.restartInterrupted": "Sessão interrompida: o OpenMausBot reiniciou.",
    "chat.notice.resumingAfterRestart": "Retomando após uma reinicialização",
    "chat.notice.cutOffByRestart": "Uma reinicialização interrompeu {name}. Retomando.",
    "chat.notice.stalled": "Sem atividade por {minutes} min. A sessão foi interrompida.",
    "chat.notice.stalledCommand":
      "O comando `{command}` rodou por {minutes} min sem terminar e parece travado. A sessão foi interrompida.",
    "chat.notice.unattendedTooLong":
      "Ninguém estava esperando por esta sessão, e ela trabalhou por {minutes} min, o limite dela. A sessão foi interrompida.",
    "chat.notice.unattendedRequests":
      "Ninguém estava esperando por esta sessão, e ela fez {count} solicitações à IA, o limite dela. A sessão foi interrompida.",
    "chat.notice.unattendedDenied":
      "Ninguém estava esperando por esta sessão, e {count} dos pedidos de permissão dela foram negados ou ficaram sem resposta. A sessão foi interrompida.",
    "chat.notice.engineExited":
      "O processo que executava a IA desta sessão terminou — a sessão foi interrompida.",
    "chat.notice.followupInterrupted":
      "Uma reinicialização ou restauração interrompeu a mensagem na fila, mas talvez ela já tenha sido processada. Confira o resultado antes de enviar novamente.",
    "chat.notice.usageLimit":
      "Esta conta de {provider} atingiu o limite de uso{detail}. Espere o limite ser renovado ou troque a IA deste bot.",
    "chat.notice.claudeExtraUsage":
      "O Claude recusou esta sessão porque este modelo consome os créditos de uso extra da sua conta, e esses créditos acabaram. O uso do seu plano não foi afetado: troque este bot para um modelo incluído no plano ou adicione uso extra na sua conta do Claude.",
    "chat.notice.claudeLimitResets":
      "Esta conta do Claude atingiu o {limit}, que será renovado em {resets}. Até lá, {meanwhile}.",
    "chat.notice.claudeLimitSaid":
      "Esta conta do Claude atingiu o {limit} (o Claude diz: “{said}”). Por enquanto, {meanwhile}.",
    "chat.notice.claudeLimit": "Esta conta do Claude atingiu o {limit}. Por enquanto, {meanwhile}.",
    "chat.notice.part.fiveHourLimit": "limite de 5 horas",
    "chat.notice.part.weeklyLimit": "limite semanal",
    "chat.notice.part.weeklyOpusLimit": "limite semanal do Opus",
    "chat.notice.part.weeklySonnetLimit": "limite semanal do Sonnet",
    "chat.notice.part.usageLimit": "limite de uso",
    "chat.notice.part.computerToolsTookTooLong": "demoraram demais para iniciar",
    "chat.notice.part.computerToolsHelperStopped": "o auxiliar delas parou",
    "chat.notice.part.computerToolsHelperFailed": "o auxiliar delas não respondeu corretamente",
    "chat.notice.part.chooseModel": "escolha outro modelo para este bot",
    "chat.notice.part.switchAccount": "use outra IA ou outra conta do Claude para este bot",
    "chat.notice.webhookHome":
      "Voltei para este computador, então meu webhook “{name}” tem um endereço aqui novamente. Abra “Automações”, escolha “Copiar endereço” em “{name}” e cole no app que envia para ele.",
    "routines.server.checksFailed":
      "Não foi possível fazer as verificações. O app tenta novamente na próxima verificação.",
    "routines.server.nothingNew": "Nada novo desde a última verificação",
    "routines.server.limitWait":
      "Esperando a renovação do limite de uso da IA. Esta execução começa novamente em {resets}",
    "routines.server.retryAfter":
      "Vai começar novamente em instantes, depois de {why}. Detalhe: {failure}",
    "routines.server.retryAfterRestart":
      "Vai começar novamente em instantes: o OpenMausBot reiniciou durante a execução",
    "routines.server.backupAi":
      "Começando novamente na IA reserva: a IA deste bot atingiu o limite de uso",
    "routines.server.waitingToStart": "Esperando para começar. Motivo: {failure}",
    "routines.server.stillBusy":
      "Não começou: o bot ainda estava ocupado depois de {minutes} minutos. Motivo: {failure}",
    "routines.server.failedAfterRetry":
      "Falhou mesmo depois de uma nova tentativa automática. Motivo: {failure}",
    "routines.server.signedOut":
      "A IA deste bot está sem login. Entre novamente em Configurações → IA. A IA disse: “{failure}”",
    "routines.server.part.stalled": "um travamento da IA",
    "routines.server.part.rateLimited": "atingir um limite de requisições",
    "routines.server.part.provider": "um erro temporário",
    "chat.narration.hide": "Ocultar as mensagens de progresso",
    "chat.narration.show": "Mostrar as mensagens de progresso",
    "chat.notice.phone.notOwner": "não é uma sessão do próprio proprietário",
    "chat.notice.phone.noPhone": "nenhum celular pareado com permissão de uso dos apps",
    "chat.notice.phone.allowed": "permitido: {tool}",
    "chat.notice.phone.denied.calendar": "Sem permissão para acessar o Calendário no celular",
    "chat.notice.phone.denied.reminders": "Sem permissão para acessar os Lembretes no celular",
    "chat.notice.phone.denied.contacts": "Sem permissão para acessar os Contatos no celular",
    "chat.notice.phone.denied.location": "Sem permissão para acessar a Localização no celular",
    "chat.notice.phone.denied.home": "Sem permissão para acessar o app Casa no celular",
    "chat.notice.phone.denied.messages": "Sem permissão para acessar o app Mensagens no celular",
    "chat.notice.phone.write.PHONE_CREATE_EVENT": "Criar evento em {phone}",
    "chat.notice.phone.write.PHONE_UPDATE_EVENT": "Atualizar evento em {phone}",
    "chat.notice.phone.write.PHONE_DELETE_EVENT": "Excluir evento em {phone}",
    "chat.notice.phone.write.PHONE_RESPOND_TO_INVITE": "Responder ao convite em {phone}",
    "chat.notice.phone.write.PHONE_CREATE_REMINDER": "Criar lembrete em {phone}",
    "chat.notice.phone.write.PHONE_UPDATE_REMINDER": "Atualizar lembrete em {phone}",
    "chat.notice.phone.write.PHONE_COMPLETE_REMINDER": "Concluir lembrete em {phone}",
    "chat.notice.phone.write.PHONE_DELETE_REMINDER": "Excluir lembrete em {phone}",
    "chat.notice.phone.write.PHONE_CREATE_CONTACT": "Criar contato em {phone}",
    "chat.notice.phone.write.PHONE_UPDATE_CONTACT": "Atualizar contato em {phone}",
    "chat.notice.phone.write.PHONE_SET_ACCESSORY": "Controlar acessório em {phone}",
    "chat.notice.phone.write.PHONE_RUN_SCENE": "Executar cena em {phone}",
    "chat.notice.phone.write.PHONE_SEND_MESSAGE": "Enviar mensagem em {phone}",
    "chat.notice.phone.write.PHONE_SEND_WHATSAPP": "Enviar mensagem pelo WhatsApp em {phone}",
    "chat.notice.acpRestarted":
      "{provider} foi reiniciado porque uma sessão que compartilha seu processo ignorou “Parar”",
    "chat.notice.acpStopFailed":
      "{provider} ignorou “Parar” e não foi possível encerrar seu processo",
    "chat.notice.toolCount":
      "{provider} recusou esta sessão porque o limite de ferramentas deste modelo é {limit} e este bot oferece mais, mesmo com as listas reduzidas. Nada foi executado. Desligue alguns apps ou servidores MCP deste bot, ou mude para outro modelo.",
    "chat.notice.toolCountUnknown":
      "{provider} recusou esta sessão porque este modelo aceita um número limitado de ferramentas e este bot oferece mais, mesmo com as listas reduzidas. Nada foi executado. Desligue alguns apps ou servidores MCP deste bot, ou mude para outro modelo.",
    "chat.notice.modelNoRoute":
      "{provider} não consegue usar o modelo {model} aqui, então escolha outro modelo para este bot.",
    "chat.notice.modelNoRouteUnnamed":
      "{provider} não consegue usar o modelo deste bot aqui, então escolha outro modelo para este bot.",
    "chat.notice.goalRetry":
      "A sessão de {name} não terminou como esperado ({why}) — tentando mais uma vez.",
    "chat.notice.part.providerFailed": "o provedor falhou",
    "chat.notice.part.dispatchFailed": "não foi possível iniciar",
    "chat.notice.part.goalStalled": "sem atividade",
    "chat.notice.part.goalTimedOut": "tempo esgotado",
    "chat.notice.goalWaiting":
      "{name} está terminando o que está fazendo. Este objetivo continuará quando o bot estiver livre.",
    "chat.notice.goalBusyOne": "{name} continuou trabalhando por {minutes} minuto",
    "chat.notice.goalBusyMany": "{name} continuou trabalhando por {minutes} minutos",
    "chat.notice.goalBusyOneAgain":
      "{name} continuou trabalhando por {minutes} minuto — envie o objetivo novamente quando o bot estiver livre.",
    "chat.notice.goalBusyManyAgain":
      "{name} continuou trabalhando por {minutes} minutos — envie o objetivo novamente quando o bot estiver livre.",
    "chat.notice.goalWorking": "{name} está trabalhando na sessão {turn} de {max}.",
    "chat.notice.goalEnded":
      "A execução do objetivo terminou antes de o bot informar um resultado.",
    "chat.notice.teammateWorking":
      "Parou aqui — {name} continua trabalhando; abra para parar esse trabalho também",
    "chat.notice.unknownTeammateWorking":
      "Parou aqui — um colega continua trabalhando; abra para parar esse trabalho também",
    "chat.notice.approve": "Aprovar: {what}",
    "chat.notice.exportedGoal.working": "{before}[Objetivo: em andamento]{content}",
    "chat.notice.exportedGoal.completed": "{before}[Objetivo: concluído]{content}",
    "chat.notice.exportedGoal.needs-input": "{before}[Objetivo: aguardando resposta]{content}",
    "chat.notice.exportedGoal.blocked": "{before}[Objetivo: bloqueado]{content}",
    "chat.notice.exportedGoal.limit-reached": "{before}[Objetivo: limite atingido]{content}",
    "chat.notice.exportedGoal.paused": "{before}[Objetivo: em pausa]{content}",
    "chat.notice.exportedGoal.stopped": "{before}[Objetivo: interrompido]{content}",
    "chat.notice.exportedGoal.failed": "{before}[Objetivo: falhou]{content}",
    "routines.server.part.failed": "um problema",
    "chat.notice.acpEmpty": "{provider} terminou sem responder.",
    "chat.notice.acpNoReason": "{provider} parou sem informar o motivo.",
    "chat.notice.acpMcpAppsFailed":
      "Não foi possível configurar os apps conectados, então {provider} não conseguiu começar esta resposta. Tente de novo ou troque a IA deste bot.",
    "chat.notice.acpMcpServerFailed":
      'Não foi possível configurar o servidor MCP "{server}", então {provider} não conseguiu começar esta resposta. Tente de novo ou troque a IA deste bot.',
    "chat.notice.stop.refusal":
      "{provider} se recusou a continuar com este pedido (motivo da parada: {reason}). Tente novamente, reformule o pedido ou mude este bot para outra IA.",
    "chat.notice.stop.refusalGeneric":
      "A IA se recusou a continuar com este pedido (motivo da parada: {reason}). Tente novamente, reformule o pedido ou mude este bot para outra IA.",
    "chat.notice.stop.maxTokens":
      "A resposta de {provider} atingiu o tamanho máximo antes de terminar (motivo da parada: {reason}). Peça para continuar ou dar uma resposta mais curta.",
    "chat.notice.stop.maxTokensGeneric":
      "A resposta da IA atingiu o tamanho máximo antes de terminar (motivo da parada: {reason}). Peça para continuar ou dar uma resposta mais curta.",
    "chat.notice.stop.maxRequests":
      "A sessão atingiu o limite de pedidos ao modelo antes de terminar (motivo da parada: {reason}). Peça para continuar de onde parou ou divida a tarefa.",
    "chat.notice.unaskedStop":
      "O pedido da IA foi interrompido antes de terminar, sem que ninguém o parasse (ela disse apenas “{said}”). Envie a mensagem novamente para tentar mais uma vez.",
    "chat.notice.piSessionSlow":
      "O Pi está demorando mais que o normal para iniciar a sessão desta conversa. A sessão de trabalho continua quando o Pi responder. Clique em “Parar” para cancelar.",
    "chat.notice.unreadMessage":
      "Esta sessão terminou antes de o modelo ler uma mensagem enviada durante a execução. Envie essa mensagem novamente.",
    "chat.notice.codexUnsupportedOne":
      "O Codex não conseguiu executar a ferramenta {tools} (“unsupported call”). O provedor de IA devolveu a chamada sem o nome do app da ferramenta, e ela nunca chegou à ferramenta. Para este bot, escolha um modelo de um provedor com suporte completo a chamadas de ferramentas.",
    "chat.notice.codexUnsupportedMany":
      "O Codex não conseguiu executar as ferramentas {tools} (“unsupported call”). O provedor de IA devolveu a chamada sem o nome do app da ferramenta, e ela nunca chegou à ferramenta. Para este bot, escolha um modelo de um provedor com suporte completo a chamadas de ferramentas.",
    "chat.notice.codexUnsupportedMore":
      "O Codex não conseguiu executar as ferramentas {tools} e mais {count} (“unsupported call”). O provedor de IA devolveu a chamada sem o nome do app da ferramenta, e ela nunca chegou à ferramenta. Para este bot, escolha um modelo de um provedor com suporte completo a chamadas de ferramentas.",
    "chat.notice.copilotAccountRefused":
      "O GitHub Copilot recusou este pedido para a conta conectada. Confira o plano do Copilot e a franquia de pedidos premium e tente novamente.",
    "chat.notice.commandCodeAccountRefused":
      "O Command Code recusou este pedido para a conta conectada. Confira o plano e os créditos em commandcode.ai e tente novamente.",
    "chat.notice.kiroAccountRefused":
      "O Kiro recusou este pedido para a conta conectada. Confira o plano e os créditos do Kiro e tente novamente.",
    "chat.notice.devinAccountRefused":
      "O Devin recusou este pedido para a conta conectada. Confira o plano e os créditos do Devin e tente novamente.",
    "chat.notice.acpQuietUsageLimit":
      "{name} atingiu um limite de uso{said} e está esperando a restrição acabar, sem responder. Por isso, esta sessão foi interrompida.",
    "chat.notice.acpQuietStuck":
      "{name} ficou {quiet} sem enviar nada. Não havia ferramenta em execução, pedido aberto ao modelo nem uso de CPU, então a sessão foi interrompida por estar travada. Envie a mensagem de novo para tentar novamente.",
    "chat.notice.acpModelRequestFailed":
      "O pedido de {name} ao modelo falhou: “{message}”. {name} pode tentar novamente ou parar. Sem resposta há {quiet}.",
    "chat.notice.acpModelFallback":
      "{displayName} não oferece mais {wanted}, então esta conversa está usando {fallback}. Para não ver mais este aviso, escolha outro modelo para este bot.",
    "chat.notice.codexActionMayHaveRun":
      "{message} Uma ferramenta pode ter executado uma ação. Confira os efeitos antes de tentar novamente.",
    "chat.notice.modelServerStoppedAnswering":
      "O servidor de modelo em {host} parou de responder, então a resposta foi interrompida.",
    "chat.notice.piModelNotConfirmed": "O Pi não confirmou o modelo selecionado",
    "chat.notice.waitingApprovalElsewhere": "Esperando sua aprovação em @{name}",
    "chat.notice.waitingAnswerElsewhere": "Esperando sua resposta em @{name}",
    "chat.notice.teammateNeedsInput": "{name} precisa da sua resposta: {question}",
    "chat.notice.relayCouldNotContinue":
      "Não foi possível continuar esta conversa. Motivo: {error}",
    "chat.notice.engineSignedOut": "{name} está sem login.",
    "chat.notice.failoverSignedInAgain":
      "{engine} está com o login ativo novamente, então esta conversa voltou para {engine}.",
    "chat.notice.failoverSignedOut": "{from} está sem login, então {to} assumiu.",
    "chat.notice.backupCardWaiting":
      "Mudou para {name}. Seu pedido aguarda sua ação em um cartão acima. Depois disso, continua em {name}.",
    "chat.notice.backupRequestUnderWay":
      "Mudou para {name}. Seu pedido ainda está em andamento aqui e continua em {name}.",
    "chat.notice.backupConversationBusy":
      "Mudou para {name}. O bot está trabalhando nesta conversa, então sua mensagem não foi enviada novamente.",
    "chat.notice.backupQuestionWaiting":
      "Mudou para {name}. Um colega aguarda sua resposta a uma pergunta nesta conversa, por isso sua mensagem não foi reenviada. Responda à pergunta e depois envie sua mensagem novamente.",
    "chat.notice.backupMessageMissing":
      "Mudou para {name}, mas não foi possível encontrar sua mensagem para reenviar. Envie novamente.",
    "chat.notice.backupContinuingLimit": "Continuando em {name} depois de atingir o limite de uso",
    "chat.notice.backupContinuingSignedOut":
      "Continuando em {name} enquanto {engine} está sem login",
    "chat.notice.backupCouldNotContinue": "Não foi possível continuar em {name}: {error}",
    "routines.server.backupSignedOut":
      "Começando novamente na IA reserva: a IA deste bot está sem login",
    "routines.server.busyTooLong": "Não rodou: o bot ficou ocupado por mais de {minutes} minutos",
    "routines.server.overLimit": "Interrompida: esta execução passou do limite de {hours} horas",
    "routines.server.stopPending":
      "O turno ainda não confirmou que parou. A próxima execução espera por isso, por até {minutes} minutos.",
    "routines.server.stopUnconfirmed":
      "O turno nunca confirmou que parou, então a próxima execução começou sem essa confirmação.",
    "routines.server.skippedOne": "Pulada porque {why}",
    "routines.server.skippedMany": "{count} execuções agendadas foram puladas porque {why}",
    "routines.server.startSkippedOne": "Não rodou nesta inicialização porque {why}",
    "routines.server.startSkippedMany": "Não rodou em {count} inicializações porque {why}",
    "routines.server.part.stillWaiting": "a execução anterior desta rotina ainda está esperando",
    "routines.server.part.stillRunning": "a execução anterior desta rotina ainda está em andamento",
    "routines.server.part.notStarted": "a execução anterior desta rotina ainda não começou",
    "routines.server.part.computerNoStart":
      "o desktop na nuvem dela não iniciou, então as próximas tentativas ficam mais espaçadas",
    "routines.server.part.runsFailed":
      "as últimas execuções dela falharam, então as próximas tentativas ficam mais espaçadas",
    "routines.server.part.restartedSoon":
      "o OpenMausBot iniciou novamente logo depois da inicialização em que ela rodou pela última vez",
    "routines.server.missedOne": "Não rodou porque {why}",
    "routines.server.missedMany": "{count} execuções agendadas não rodaram porque {why}",
    "routines.server.missedTooLate":
      "Não rodou porque {why} até mais de {hours} horas depois do horário",
    "routines.server.part.computerOff":
      "este computador estava em repouso ou o OpenMausBot não estava aberto",
    "routines.server.part.cloudDown": "este Cloud estava dormindo ou reiniciando",
    "routines.server.part.heldUp": "o agendador ficou preso iniciando outra execução",
    "routines.server.restored":
      "Não rodou de novo: este agendamento foi restaurado de um backup feito antes de esta execução ter a vez dela",
    "routines.server.restoredMany":
      "Não rodaram de novo: {count} execuções agendadas de antes de este agendamento ser restaurado de um backup",
    "routines.server.duplicate": "Não iniciou: esta execução agendada já tinha iniciado uma vez",
    "routines.server.capSkippedOne":
      "Pulada: {why} ({amount}) foi atingido. As execuções voltam a começar depois de {resets}",
    "routines.server.capSkippedMany":
      "{count} execuções puladas: {why} ({amount}) foi atingido. As execuções voltam a começar depois de {resets}",
    "routines.server.part.capServerDay": "o limite diário de uso de todos os bots",
    "routines.server.part.capServerMonth": "o limite mensal de uso de todos os bots",
    "routines.server.part.capBotDay": "o limite diário de uso deste bot",
    "routines.server.part.capBotMonth": "o limite mensal de uso deste bot",
    "chat.notice.waitDone.urlContains": "Espera concluída: {label}. {url} agora contém “{text}”.",
    "chat.notice.waitDone.urlMissing": "Espera concluída: {label}. {url} não contém mais “{text}”.",
    "chat.notice.waitDone.fileExists": "Espera concluída: {label}. {path} agora existe.",
    "chat.notice.waitDone.fileMissing": "Espera concluída: {label}. {path} não existe mais.",
    "chat.notice.waitDone.fileChanged": "Espera concluída: {label}. {path} mudou.",
    "chat.notice.waitDone.processRunning": "Espera concluída: {label}. {process} está em execução.",
    "chat.notice.waitDone.processGone": "Espera concluída: {label}. {process} parou.",
    "chat.notice.waitDone.botIdle": "Espera concluída: {label}. {botName} terminou.",
    "chat.notice.waitBotGone": "A espera por {label} foi encerrada: {botName} não existe mais.",
    "chat.notice.waitExpiredOne": "A espera por {label} foi encerrada após {hours} h.",
    "chat.notice.waitExpiredMany": "A espera por {label} foi encerrada após {hours} h.",
    "chat.notice.computerDesktopOnly":
      "Só o app OpenMausBot neste computador pode permitir que um bot o use. Abra o app aqui ou deixe o bot trabalhar no próprio navegador ou em um desktop na nuvem.",
    "chat.notice.computerPermissionsThenRestart":
      "O OpenMausBot ainda não consegue usar este computador. Confira se o OpenMausBot tem as permissões que pede e reinicie o app.",
    "chat.notice.computerNotReadyDetail":
      "O OpenMausBot ainda não consegue usar este computador. Motivo: {reason}",
    "chat.notice.computerToolsDidNotStart":
      "As ferramentas deste computador não iniciaram desta vez ({why}). Envie sua mensagem de novo daqui a pouco.",
    "chat.notice.computerToolsStillNotStarting":
      "As ferramentas deste computador ainda não estão iniciando.",
    "chat.notice.computerNotReadyMacPermission":
      "O OpenMausBot ainda não consegue usar este computador. Motivo: {reason}. Abra o OpenMausBot novamente depois de conceder a permissão do macOS que falta.",
    "chat.notice.computerSystemUnsupported":
      "Os bots não podem usar este computador neste sistema. Escolha outro lugar para este bot trabalhar",
    "chat.notice.computerAiUnsupported":
      "A IA deste bot não pode usar este computador. Escolha outra IA ou outro lugar para o bot trabalhar",
    "chat.notice.memoryReclaimedBrowser":
      "Faltou memória, então fechei o navegador para manter o restante funcionando.",
    "chat.notice.memoryReclaimedTask":
      "Faltou memória, então interrompi esta tarefa para manter o restante funcionando.",
    "chat.notice.memoryReclaimedBrowserDetail":
      "Faltou memória, então fechei o navegador para manter o restante funcionando. ({detail})",
    "chat.notice.memoryReclaimedTaskDetail":
      "Faltou memória, então interrompi esta tarefa para manter o restante funcionando. ({detail})",
    "chat.notice.outOfProcesses":
      "Não há espaço para iniciar outro programa ({code}), então esta tarefa não pôde rodar. Nada foi enviado à IA. Ela começa de novo sozinha quando houver espaço.",
    "chat.notice.elicitationUrlDeclined":
      "{server} pediu que você abrisse um link para continuar. O OpenMausBot não pode abri-lo por aqui, então o pedido foi recusado. Abra o link e peça ao bot para tentar novamente.",
    "chat.notice.elicitationUrlDeclinedWithUrl":
      "{server} pediu que você abrisse um link para continuar: {url}. O OpenMausBot não pode abri-lo por aqui, então o pedido foi recusado. Abra o link e peça ao bot para tentar novamente.",
    "chat.notice.elicitationUrlDeclinedGeneric":
      "Um servidor MCP pediu que você abrisse um link para continuar. O OpenMausBot não pode abri-lo por aqui, então o pedido foi recusado. Abra o link e peça ao bot para tentar novamente.",
    "chat.notice.elicitationUrlDeclinedGenericWithUrl":
      "Um servidor MCP pediu que você abrisse um link para continuar: {url}. O OpenMausBot não pode abri-lo por aqui, então o pedido foi recusado. Abra o link e peça ao bot para tentar novamente.",
    "chat.notice.elicitationFormDeclinedOne":
      "{server} pediu que você preenchesse um campo. O OpenMausBot ainda não pode mostrar esse formulário, então o pedido foi recusado.",
    "chat.notice.elicitationFormDeclinedMany":
      "{server} pediu que você preenchesse {fields} campos. O OpenMausBot ainda não pode mostrar esse formulário, então o pedido foi recusado.",
    "chat.notice.elicitationFormDeclinedOneMessage":
      "{server} pediu que você preenchesse um campo (“{message}”). O OpenMausBot ainda não pode mostrar esse formulário, então o pedido foi recusado.",
    "chat.notice.elicitationFormDeclinedManyMessage":
      "{server} pediu que você preenchesse {fields} campos (“{message}”). O OpenMausBot ainda não pode mostrar esse formulário, então o pedido foi recusado.",
    "chat.notice.elicitationFormDeclinedGenericOne":
      "Um servidor MCP pediu que você preenchesse um campo. O OpenMausBot ainda não pode mostrar esse formulário, então o pedido foi recusado.",
    "chat.notice.elicitationFormDeclinedGenericMany":
      "Um servidor MCP pediu que você preenchesse {fields} campos. O OpenMausBot ainda não pode mostrar esse formulário, então o pedido foi recusado.",
    "chat.notice.elicitationFormDeclinedGenericOneMessage":
      "Um servidor MCP pediu que você preenchesse um campo (“{message}”). O OpenMausBot ainda não pode mostrar esse formulário, então o pedido foi recusado.",
    "chat.notice.elicitationFormDeclinedGenericManyMessage":
      "Um servidor MCP pediu que você preenchesse {fields} campos (“{message}”). O OpenMausBot ainda não pode mostrar esse formulário, então o pedido foi recusado.",
    "chat.notice.elicitationContinue": "{server} pede para continuar",
    "chat.notice.elicitationContinueGeneric": "Um servidor MCP pede para continuar",
    "chat.notice.elicitationMessageGeneric": "Um servidor MCP: {message}",
    "chat.notice.appAccessRequested": "Pedido de acesso ao app",
    "chat.notice.codexModelUnavailable":
      "Este modelo não está disponível no seu plano do ChatGPT, por isso agora está oculto na lista de modelos desta conta. Escolha outro modelo.",
    "chat.notice.codexElicitationDeclined":
      "{server} pediu informações que o OpenMausBot ainda não pode mostrar, então o pedido foi recusado.",
    "chat.notice.codexElicitationDeclinedGeneric":
      "Um servidor MCP pediu informações que o OpenMausBot ainda não pode mostrar, então o pedido foi recusado.",
    "chat.notice.usageLimitResets":
      "Esta conta de {provider} atingiu o limite de uso{detail}, que será renovado em {resets}. Até lá, troque a IA deste bot.",
  },
  es: {
    "chat.messageActions": "Acciones del mensaje",
    "task.updated.justNow": "ahora mismo",
    "task.updated.minutes": "hace {count} min",
    "task.updated.hours": "hace {count} h",
    "task.updated.yesterday": "ayer",
    "task.updated.days": "hace {count} d",
    "chat.reply.replyingTo": "Respondiendo a {name}",
    "chat.reply.jump": "Ir al mensaje original",
    "chat.reply.cancel": "Cancelar la respuesta",
    "chat.copyLink": "Copiar enlace",
    "chat.showFull": "Ver el mensaje completo",
    "chat.showLess": "Mostrar menos",
    "common.copyFailed": "No se pudo copiar",
    "chat.more": "Más",
    "chat.notice.devinAccountRefused":
      "Devin rechazó esta solicitud para la cuenta conectada. Revisa el plan y los créditos de Devin e inténtalo de nuevo.",
    "question.showFull": "Mostrar la pregunta completa",
    "question.showLess": "Mostrar menos",
    "toolDetail.label": "{name} · {status} · Detalles de la herramienta",
    "toolDetail.input": "Entrada",
    "toolDetail.output": "Resultado",
    "toolDetail.running": "En curso",
    "toolDetail.failed": "Falló",
    "toolDetail.completed": "Completado",
    "toolDetail.unverified": "Sin resultado",
    "toolDetail.waiting": "Esperando a que termine la herramienta…",
    "toolDetail.noOutput": "No se registró ninguna salida para esta llamada.",
    "toolDetail.previewHint":
      "Entrada y salida de la herramienta en esta sesión. Revísalas antes de compartirlas.",
    "toolDetail.tool": "Herramienta",
    "toolStep.runCommand": "Ejecutar un comando",
    "toolStep.readFile": "Leer un archivo",
    "toolStep.writeFile": "Escribir un archivo",
    "toolStep.editFile": "Editar un archivo",
    "toolStep.deleteFile": "Eliminar un archivo",
    "toolStep.searchFiles": "Buscar archivos",
    "toolStep.searchWeb": "Buscar en la web",
    "toolStep.openWebPage": "Abrir una página web",
    "toolStep.lookAtScreen": "Mirar la pantalla",
    "toolStep.useComputer": "Usar la pantalla",
    "toolStep.useBrowser": "Usar el navegador",
    "toolStep.updatePlan": "Actualizar el plan",
    "toolStep.askHelper": "Pasar una tarea a un ayudante",
    "toolStep.think": "Pensar",
    "toolStep.checkTeam": "Consultar al equipo",
    "toolStep.manageAutomations": "Gestionar automatizaciones",
    "toolStep.checkAutomations": "Consultar automatizaciones",
    "toolStep.useTool": "Usar una herramienta",
    "chat.run.worked": "Trabajó",
    "chat.run.workedFor": "Trabajó durante {elapsed}",
    "chat.run.steps": "{count} pasos · {tools}",
    "chat.run.showSteps": "Ver todos los pasos",
    "chat.run.more": "+{count} más",
    "place.cloud": "Escritorio en la nube",
    "place.vm": "Escritorio privado",
    "place.local": "Este equipo",
    "place.browser": "Navegador",
    "place.auto": "Auto",
    "place.off": "Desactivado",
    "place.chipTitle": "Dónde trabaja esta conversación",
    "place.chipAria": "Dónde trabaja esta conversación: {place}",
    "place.pinnedHere": "Fijado para esta conversación",
    "place.fromBot": "Del ajuste «Trabaja en» de este bot",
    "place.live": "En uso ahora",
    "place.busy": "Espera a que termine el turno actual",
    "place.offHint":
      "«Trabaja en» está en «Desactivado» para este bot. Cámbialo en el panel Pantalla.",
    "place.followBot": "Seguir el ajuste de este bot",
    "place.followBotDetail": "Ahora: {place}",
    "place.autoDetail": "Elige el lugar adecuado para cada tarea",
    "place.unavailable": "No disponible para el modelo o la configuración de este bot",
    "place.pinnedNote":
      "Esta conversación está fijada a {place}. Cámbialo desde el cuadro de mensaje.",
    "place.pinnedNoteSimple": "Este chat está fijado a «{place}».",
    "place.unpinSimple": "Usar {place}",
    "place.view.auto.short": "Elige por ti",
    "place.view.auto.lineMyCloud":
      "Usa el navegador integrado. En un chat, inicia su escritorio en la nube por sí solo cuando una tarea necesita apps de escritorio.",
    "place.view.auto.lineDesktop":
      "Usa el navegador integrado, un escritorio privado en este equipo o la pantalla de este equipo, según lo que necesite la tarea.",
    "place.view.auto.lineLinux":
      "Usa el navegador integrado, o un escritorio privado en marcha cuando una tarea lo necesita.",
    "place.view.autoTeam.short": "Compartido",
    "place.view.autoTeam.line":
      "Usa {computer}, el escritorio en la nube que comparte este departamento.",
    "place.view.ccCannot.short": "No con este modelo",
    "place.view.ccCannot.line":
      "{model} no puede usar un escritorio. Elige un modelo que pueda, como Claude o ChatGPT.",
    "place.view.ccToolsOff.short": "No permitido",
    "place.view.ccToolsOff.line": "Lo que {bot} puede usar no incluye un escritorio.",
    "place.view.ccSignIn.short": "Inicia sesión primero",
    "place.view.ccSignIn.line":
      "Primero inicia sesión en {engine}. {bot} también lo usa en su escritorio en la nube.",
    "place.view.ccSignIn.lineMyCloud":
      "Primero inicia sesión en {engine} en la Cloud. {bot} también lo usa en su escritorio en la nube.",
    "place.view.ccNew.short": "Listo",
    "place.view.ccNew.line":
      "{bot} recibe su propio escritorio en la nube de Boat la primera vez que una tarea lo necesita. El primer inicio tarda aproximadamente un minuto.",
    "place.view.ccStarting.short": "Iniciando…",
    "place.view.ccStarting.line":
      "Iniciando el escritorio en la nube de {bot}. El primer inicio tarda aproximadamente un minuto.",
    "place.view.ccWaking.short": "Despertando…",
    "place.view.ccWaking.line":
      "Despertando el escritorio en la nube de {bot}. Tarda unos segundos.",
    "place.view.ccOn.short": "Encendido",
    "place.view.ccOn.line":
      "El escritorio en la nube de {bot} está encendido. Entra en reposo tras 10 minutos sin uso.",
    "place.view.ccAsleep.short": "En reposo",
    "place.view.ccAsleep.line":
      "El escritorio en la nube de {bot} está en reposo. Se despierta en unos segundos cuando {bot} lo necesita.",
    "place.view.ccNoHours.short": "Sin horas disponibles",
    "place.view.ccNoHours.line":
      "Se agotaron las {hours} horas de escritorio en la nube de este mes. Vuelven el 1 de {month}.",
    "place.view.ccNoHours.lineUnknown":
      "Se agotaron las horas de escritorio en la nube de este mes.",
    "place.view.ccNoHours.lineTrial":
      "Se agotaron las horas de escritorio en la nube de la prueba gratis. La asignación completa empieza con el primer pago.",
    "place.view.ccAtOnce.short": "En uso",
    "place.view.ccAtOnce.lineOne":
      "Tu plan {plan} incluye 1 escritorio en la nube, y lo tiene {holders}.",
    "place.view.ccAtOnce.lineMany":
      "Tu plan {plan} incluye {max} escritorios en la nube, y los tienen {holders}.",
    "place.view.ccAtOnce.lineUnknown":
      "Todos los escritorios en la nube que incluye tu plan están en uso.",
    "place.view.ccUnavailable.short": "No disponible ahora",
    "place.view.ccUnavailable.line":
      "Los escritorios en la nube no pueden iniciarse ahora mismo. No es por nada que hayas hecho.",
    "place.view.ccEnded.short": "Plan terminado",
    "place.view.ccEnded.line":
      "Tu plan de MausBot Cloud terminó, así que los escritorios en la nube están apagados.",
    "place.view.ccNoStart.short": "No se inició",
    "place.view.ccNoStart.line": "El escritorio en la nube de {bot} no se inició.",
    "place.view.ccClearing.short": "Limpiando",
    "place.view.ccClearing.line":
      "El escritorio en la nube anterior de {bot} todavía se está eliminando.",
    "place.view.ccProvider.short": "No se pudo iniciar",
    "place.view.ccProvider.line":
      "Tu cuenta de Boat no pudo iniciar el escritorio en la nube de {bot}: {words}",
    "place.view.ccOnMyCloud.short": "Para bots de la Cloud",
    "place.view.ccOnMyCloud.line":
      "Por ahora, los escritorios en la nube de tu plan funcionan para los bots de la Cloud.",
    "place.view.ccNeedsKey.short": "Conecta Boat primero",
    "place.view.ccNeedsKey.line":
      "Aquí los bots pueden tener sus propios escritorios en la nube de Boat, un servicio de pago.",
    "place.view.vps.short": "Tu propia máquina",
    "place.view.vps.line": "Usa tu propia máquina Linux, conectada por SSH.",
    "place.view.browserOff.short": "Desactivado",
    "place.view.browserOff.line":
      "El navegador propio del bot está desactivado, así que no puede abrir páginas web.",
    "place.view.browserCannot.short": "No con este modelo",
    "place.view.browserCannot.line": "{model} no puede usar el navegador integrado.",
    "place.view.localUnavailable.short": "Aún no se puede usar",
    "place.view.localUnavailable.line": "{reason}",
    "place.view.vmCannot.short": "No con este modelo",
    "place.view.vmCannot.line":
      "{model} no puede usar un escritorio privado. Elige un modelo que pueda, como Claude o ChatGPT.",
    "place.view.placeFailed.short": "No se inició",
    "place.view.placeFailed.line": "{cause}",
    "place.view.off.short": "Sin pantalla",
    "place.view.off.line":
      "{bot} no tiene pantalla. Aun así puede chatear y hacer todo lo que no la necesite.",
    "place.action.chooseModel": "Elegir un modelo",
    "place.action.openTools": "Cambiar lo que {bot} puede usar",
    "place.action.signIn": "Iniciar sesión",
    "place.action.start": "Iniciarlo ahora",
    "place.action.wake": "Despertarlo ahora",
    "place.action.watch": "Ver",
    "place.action.seePlan": "Ver tu plan",
    "place.action.manageComputers": "Gestionar los escritorios en la nube",
    "place.action.tryAgain": "Inténtalo de nuevo",
    "place.action.openMyCloud": "Abrir la Cloud",
    "place.action.addBoatKey": "Conectar Boat",
    "place.action.turnOnBrowser": "Activar el navegador",
    "place.action.openTeamMap": "Abrir el Mapa del equipo",
    "place.action.openVmSettings": "Ajustes del escritorio privado",
    "place.action.clearPin": "Quitar el lugar fijado de esta conversación",
    "place.action.usePlace": "Usar {place}",
    "place.action.changeRoutine": "Cambiar dónde se ejecuta",
    "place.action.openComputerPanel": "Abrir el panel Pantalla",
    "place.askAdmin": "Pide a un Admin que lo cambie.",
    "place.backOnAuto": "Esta conversación vuelve a estar en Auto.",
  },
};
