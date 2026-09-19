/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 selimawn
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { Margins } from "@utils/margins";
import definePlugin, { IconComponent, OptionType, PluginNative } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import {
    ConfirmModal,
    ContextMenuApi,
    Menu,
    Modal,
    openModal,
    showToast,
    TextInput,
    Toasts,
    useState
} from "@webpack/common";

import type * as NativeApi from "./native";

const Native = VencordNative.pluginHelpers.SwissTransfer as PluginNative<typeof NativeApi>;
const logger = new Logger("SwissTransfer");

const DURATION_OPTIONS = [
    { label: "1 day", value: 1 },
    { label: "3 days", value: 3 },
    { label: "7 days", value: 7 },
    { label: "15 days", value: 15 },
    { label: "30 days", value: 30, default: true }
] as const;

const DOWNLOAD_OPTIONS = [
    { label: "1", value: 1 },
    { label: "20", value: 20 },
    { label: "100", value: 100 },
    { label: "200", value: 200 },
    { label: "250", value: 250, default: true }
] as const;

const settings = definePluginSettings({
    email: {
        type: OptionType.STRING,
        description: "Sender email Swiss Transfer will verify once",
        placeholder: "you@example.com",
        isValid(value: string) {
            if (!value.trim()) return "Swiss Transfer needs a sender email";
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return "That does not look like an email";
            return true;
        },
        onChange() {
            settings.store.emailValidationId = "";
        }
    },
    duration: {
        type: OptionType.SELECT,
        description: "How long the download link stays available",
        options: [...DURATION_OPTIONS]
    },
    maxDownloads: {
        type: OptionType.SELECT,
        description: "Maximum number of downloads",
        options: [...DOWNLOAD_OPTIONS]
    },
    password: {
        type: OptionType.STRING,
        description: "Optional password for the transfer",
        default: "",
        placeholder: "Leave empty for no password"
    },
    message: {
        type: OptionType.STRING,
        description: "Optional message shown on the download page",
        default: "",
        placeholder: "Hello"
    },
    language: {
        type: OptionType.SELECT,
        description: "Language of the Swiss Transfer page",
        options: [
            { label: "English", value: "en", default: true },
            { label: "French", value: "fr" },
            { label: "German", value: "de" },
            { label: "Italian", value: "it" },
            { label: "Spanish", value: "es" }
        ]
    },
    emailValidationId: {
        type: OptionType.STRING,
        description: "Cached Swiss Transfer email confirmation",
        default: "",
        hidden: true
    }
});

const UploadIcon: IconComponent = ({ height = 24, width = 24, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M11 16V7.83L8.41 10.41a1 1 0 1 1-1.41-1.41l4.29-4.3a1 1 0 0 1 1.42 0l4.29 4.3a1 1 0 1 1-1.41 1.41L13 7.83V16a1 1 0 1 1-2 0Z" />
        <path d="M5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z" />
    </svg>
);

function promptEmailCode(email: string, message: string): Promise<string | null> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        openModal(props => {
            const [code, setCode] = useState("");
            const [busy, setBusy] = useState(false);
            const token = code.replace(/[^a-zA-Z0-9]/g, "");

            return (
                <Modal
                    {...props}
                    title="Confirm your email"
                    subtitle={message}
                    actions={[
                        {
                            text: "Cancel",
                            variant: "secondary",
                            onClick() {
                                props.onClose();
                                finish(null);
                            }
                        },
                        {
                            text: "Confirm",
                            variant: "primary",
                            loading: busy,
                            disabled: token.length !== 6 || busy,
                            onClick() {
                                setBusy(true);
                                finish(token);
                                props.onClose();
                            }
                        }
                    ]}
                >
                    <Paragraph className={Margins.bottom8}>
                        Enter the 6-character code sent to {email}. Check your spam folder if it is missing.
                    </Paragraph>
                    <TextInput
                        value={code}
                        onChange={setCode}
                        placeholder="ABC123"
                        maxLength={8}
                    />
                </Modal>
            );
        }, { onCloseCallback: () => finish(null) });
    });
}

function askInsertOrSend(channelId: string, url: string) {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Swiss Transfer"
            variant="primary"
            confirmText="Send"
            cancelText="Insert"
            onConfirm={() => sendMessage(channelId, { content: url })}
            onCancel={() => insertTextIntoChatInputBox(url)}
        >
            <Paragraph className={Margins.bottom8}>
                The file is online. Send the link in this channel, or insert it into the message box?
            </Paragraph>
            <Paragraph>{url}</Paragraph>
        </ConfirmModal>
    ));
}

function uploadOptions() {
    return {
        email: settings.store.email.trim(),
        emailValidationId: settings.store.emailValidationId || undefined,
        duration: Number(settings.store.duration),
        maxDownloads: Number(settings.store.maxDownloads),
        password: settings.store.password ?? "",
        message: settings.store.message ?? "",
        language: String(settings.store.language)
    };
}

async function uploadSelected(channel: Channel, paths: string[]) {
    if (!paths.length) return;

    showToast("Uploading to Swiss Transfer…", Toasts.Type.MESSAGE);

    let result = await Native.uploadFiles(paths, uploadOptions());

    if (!result.ok && result.reason === "need_email") {
        showToast(result.message, Toasts.Type.FAILURE);
        return;
    }

    if (!result.ok && result.reason === "need_code") {
        settings.store.emailValidationId = result.emailValidationId;
        const code = await promptEmailCode(settings.store.email.trim(), result.message);
        if (!code) return;

        const confirmed = await Native.confirmEmail(
            settings.store.email.trim(),
            result.emailValidationId,
            code
        );
        if (!confirmed.ok) {
            settings.store.emailValidationId = "";
            showToast(confirmed.message, Toasts.Type.FAILURE);
            return;
        }

        showToast("Uploading to Swiss Transfer…", Toasts.Type.MESSAGE);
        result = await Native.uploadFiles(paths, uploadOptions());
    }

    if (!result.ok) {
        if (result.reason === "need_code") {
            settings.store.emailValidationId = result.emailValidationId;
            showToast(result.message, Toasts.Type.FAILURE);
            return;
        }
        logger.error(result.message);
        showToast(result.message, Toasts.Type.FAILURE);
        return;
    }

    settings.store.emailValidationId = result.emailValidationId;
    showToast("Swiss Transfer upload finished", Toasts.Type.SUCCESS);
    askInsertOrSend(channel.id, result.url);
}

async function pickAndUpload(kind: "files" | "photos", channel: Channel) {
    try {
        if (!settings.store.email?.trim()) {
            showToast("Set your sender email in Swiss Transfer plugin settings", Toasts.Type.FAILURE);
            return;
        }
        const paths = await Native.pickFiles(kind);
        await uploadSelected(channel, paths);
    } catch (error) {
        logger.error(error);
        showToast(error instanceof Error ? error.message : String(error), Toasts.Type.FAILURE);
    }
}

function openUploadMenu(event: UIEvent, channel: Channel) {
    ContextMenuApi.openContextMenu(event, () => (
        <Menu.Menu
            navId="vc-swiss-transfer-upload"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="Swiss Transfer"
        >
            <Menu.MenuItem
                id="vc-swiss-transfer-files"
                label="Files"
                action={() => void pickAndUpload("files", channel)}
            />
            <Menu.MenuItem
                id="vc-swiss-transfer-photos"
                label="Photos"
                action={() => void pickAndUpload("photos", channel)}
            />
        </Menu.Menu>
    ));
}

const UploadButton: ChatBarButtonFactory = ({ isAnyChat, channel }) => {
    if (!isAnyChat) return null;

    return (
        <ChatBarButton
            tooltip="Upload with Swiss Transfer"
            onClick={event => openUploadMenu(event, channel)}
            buttonProps={{ "aria-haspopup": "menu" }}
        >
            <UploadIcon />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "SwissTransfer",
    description: "Upload files through Swiss Transfer from the Discord chat bar",
    tags: ["Chat", "Utility"],
    authors: [{ name: "selimawn", id: 0n }],
    settings,
    requiresRestart: false,

    settingsAboutComponent: () => (
        <>
            <Heading>Swiss Transfer</Heading>
            <Paragraph>
                Adds an Upload button next to GIFs, stickers and gifts. Files go to Swiss Transfer, not Discord.
                The first upload from an email asks for the 6-character code Infomaniak sends you.
            </Paragraph>
        </>
    ),

    chatBarButton: {
        icon: UploadIcon,
        render: UploadButton
    }
});
