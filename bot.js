const { Events } = require('discord.js');
const { Client, GatewayIntentBits, ActivityType, ApplicationCommandOptionType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS previous_roles (user_id TEXT PRIMARY KEY, roles TEXT)`);
});

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ] 
});
require('dotenv').config();

const bridges = []

fs.readdirSync('./bridges').forEach(file => {
    bridges.push(
        JSON.parse(fs.readFileSync(`./bridges/${file}`, 'utf8'))
    );
});

const BRIDGES_DIR = './bridges';

function saveBridge(bridgeId, data) {
    const filePath = path.join(BRIDGES_DIR, `${bridgeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
}

function loadBridge(bridgeId) {
    const filePath = path.join(BRIDGES_DIR, `${bridgeId}.json`);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return null;
}

class Bridge {
    constructor(client) {
        this.client = client;
        this.webhooks = new Map();
        this.messageMap = new Map();
        this.reverseMessageMap = new Map();
        this.setupBridges();
        this.registerCommands();

        this.client.on('interactionCreate', async interaction => {
            if (!interaction.isCommand()) return;
            if (interaction.commandName === 'dev') {
                await this.handleDevCommand(interaction);
            }
        });
    }

    async setupBridges() {
        for (const bridge of bridges) {
            for (const channelId of bridge.channels) {
                const channel = this.client.channels.cache.get(channelId);
                if (!channel || !channel.isTextBased()) {
                    log(`Channel not found or not a text channel: ${channelId}`, 'BRIDGE-SETUP');
                    continue;
                }

                const webhook = await this.getOrCreateWebhook(channel, bridge);
                this.webhooks.set(channelId, webhook);
            }

            this.client.on('messageCreate', (message) => this.handleMessage(message, bridge));
            this.client.on('messageUpdate', (oldMessage, newMessage) => this.handleMessageUpdate(oldMessage, newMessage, bridge));
            this.client.on('messageDelete', (message) => this.handleMessageDelete(message, bridge));
        }
    }

    async getOrCreateWebhook(channel, bridge) {
        const existingWebhooks = await channel.fetchWebhooks();
        const webhook = existingWebhooks.find(wh => wh.owner.id === this.client.user.id);
        if (webhook) {
            log(`Found existing webhook for '${bridge.name}'`, 'BRIDGE-GET-OR-CREATE-WEBHOOK');
            return webhook;
        } else {
            log(`Creating webhook for '${bridge.name}'`, 'BRIDGE-GET-OR-CREATE-WEBHOOK');
            return await channel.createWebhook({
                name: bridge.name,
                avatar: this.client.user.displayAvatarURL({ dynamic: true })
            });
        }
    }

    async handleMessage(message, bridge) {
        if (message.author.bot && !message.webhookId) return;
        if (!bridge.channels.includes(message.channel.id)) return;

        if (message.webhookId) return;

        const content = message.content;
        const files = message.attachments.map(attachment => attachment.url);
        const embeds = message.embeds;

        if (!content && files.length === 0 && embeds.length === 0) return;
        if (content.startsWith('!')) return;
        if (bridge.blacklist_roles.some(roleId => message.member.roles.cache.has(roleId))) return;

        const webhookMessageIds = new Map();

        for (const channelId of bridge.channels) {
            if (channelId !== message.channel.id) {
                const webhook = this.webhooks.get(channelId);
                let username = message.author.displayName || message.author.username;
                const regex = /\b(clyde|discord)\b/i;
                if (regex.test(username)) {
                    username = username.replace(regex, "[redacted]");
                }

                if (webhook) {
                    try {
                        const webhookPayload = {
                            content: content,
                            username: bridge.name_format.replace('{{GUILDNAME}}', message.guild.name).replace('{{USERNAME}}', username),
                            avatarURL: message.author.displayAvatarURL({ dynamic: true }),
                            files: files,
                            embeds: embeds,
                            allowedMentions: {
                                parse: ['users']
                            }
                        };

                        const sentMessage = await webhook.send(webhookPayload);
                        webhookMessageIds.set(channelId, sentMessage.id);
                    } catch (error) {
                        console.error(`Failed to send message to channel ${channelId}:`, error);
                    }
                }
            }
        }

        this.messageMap.set(message.id, webhookMessageIds);
    }

    async handleMessageUpdate(oldMessage, newMessage, bridge) {
        if (newMessage.author.bot || newMessage.webhookId) return;
        if (!bridge.channels.includes(newMessage.channel.id)) return;

        const content = newMessage.content;
        const files = Array.from(newMessage.attachments.values());
        const embeds = newMessage.embeds;

        if (!this.messageMap.has(newMessage.id)) {
            log(`Message not mapped - ${newMessage.member?.displayName || newMessage.author.username}`, 'BRIDGE-HANDLE-MESSAGE-UPDATE');
            return;
        }

        const mappedChannels = this.messageMap.get(newMessage.id);

        for (const channelId of bridge.channels) {
            if (channelId !== newMessage.channel.id) {
                const webhook = this.webhooks.get(channelId);
                const webhookMessageId = mappedChannels.get(channelId);
                if (webhook && webhookMessageId) {
                    try {
                        await webhook.editMessage(webhookMessageId, {
                            content: content.slice(0, 2000),
                            embeds: embeds,
                            files: files,
                        });
                        log(`Edited message in channel ${channelId}`, 'BRIDGE-HANDLE-MESSAGE-UPDATE');
                    } catch (error) {
                        log(`Failed to edit message in channel ${channelId}: ${error}`, 'BRIDGE-HANDLE-MESSAGE-UPDATE');
                    }
                }
            }
        }
    }

    async handleMessageDelete(message, bridge) {
        if (!this.messageMap.has(message.id)) {
            log(`Message not mapped - ${message.member?.displayName || message.author.username}`, 'BRIDGE-HANDLE-MESSAGE-DELETE');
            return;
        }

        const mappedChannels = this.messageMap.get(message.id);

        for (const channelId of bridge.channels) {
            if (channelId !== message.channel.id) {
                const webhook = this.webhooks.get(channelId);
                const webhookMessageId = mappedChannels.get(channelId);
                if (webhook && webhookMessageId) {
                    try {
                        await webhook.deleteMessage(webhookMessageId);
                        log(`Deleted message in channel ${channelId}`, 'BRIDGE-HANDLE-MESSAGE-DELETE');
                    } catch (error) {
                        log(`Failed to delete message in channel ${channelId}: ${error}`, 'BRIDGE-HANDLE-MESSAGE-DELETE');
                    }
                }
            }
        }

        this.messageMap.delete(message.id);
    }

    async registerCommands() {
        const devCommand = {
            name: 'dev',
            description: 'Developer commands for managing bridges',
            options: [
                {
                    name: 'create',
                    description: 'Create a new bridge',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'name',
                            description: 'Name of the bridge',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        },
                        {
                            name: 'channel1',
                            description: 'First channel to bridge',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        },
                        {
                            name: 'channel2',
                            description: 'Second channel to bridge',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: 'edit',
                    description: 'Edit an existing bridge',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'bridge_id',
                            description: 'ID of the bridge to edit',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        },
                        {
                            name: 'name',
                            description: 'New name for the bridge',
                            type: ApplicationCommandOptionType.String,
                            required: false
                        },
                        {
                            name: 'add_channel',
                            description: 'Add a channel to the bridge',
                            type: ApplicationCommandOptionType.String,
                            required: false
                        },
                        {
                            name: 'remove_channel',
                            description: 'Remove a channel from the bridge',
                            type: ApplicationCommandOptionType.String,
                            required: false
                        }
                    ]
                },
                {
                    name: 'list',
                    description: 'List all bridges',
                    type: ApplicationCommandOptionType.Subcommand
                },
                {
                    name: 'delete',
                    description: 'Delete a bridge',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'bridge_id',
                            description: 'ID of the bridge to delete',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        }
                    ]
                },
                {
                    name: 'status',
                    description: 'Update bot status and activity',
                    type: ApplicationCommandOptionType.Subcommand,
                    options: [
                        {
                            name: 'type',
                            description: 'Activity type',
                            type: ApplicationCommandOptionType.String,
                            required: true,
                            choices: [
                                { name: 'Playing', value: 'Playing' },
                                { name: 'Streaming', value: 'Streaming' },
                                { name: 'Listening', value: 'Listening' },
                                { name: 'Watching', value: 'Watching' },
                                { name: 'Custom', value: 'Custom' },
                                { name: 'Competing', value: 'Competing' }
                            ]
                        },
                        {
                            name: 'text',
                            description: 'Status text',
                            type: ApplicationCommandOptionType.String,
                            required: true
                        },
                        {
                            name: 'url',
                            description: 'URL (required for Streaming activity)',
                            type: ApplicationCommandOptionType.String,
                            required: false
                        },
                        {
                            name: 'status',
                            description: 'Online status',
                            type: ApplicationCommandOptionType.String,
                            required: false,
                            choices: [
                                { name: 'Online', value: 'online' },
                                { name: 'Idle', value: 'idle' },
                                { name: 'Do Not Disturb', value: 'dnd' },
                                { name: 'Invisible', value: 'invisible' }
                            ]
                        }
                    ]
                }
            ]
        };

        try {
            await this.client.application.commands.create(devCommand);
            log('Registered dev commands successfully', 'COMMANDS');
        } catch (error) {
            log(`Failed to register commands: ${error}`, 'COMMANDS');
        }
    }

    async handleDevCommand(interaction) {
        if (interaction.member.id !== process.env.OWNER_ID) {
            await interaction.reply({ content: '❌ You are not allowed to use this command!', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'create':
                await this.handleCreateBridge(interaction);
                break;
            case 'edit':
                await this.handleEditBridge(interaction);
                break;
            case 'list':
                await this.handleListBridges(interaction);
                break;
            case 'delete':
                await this.handleDeleteBridge(interaction);
                break;
            case 'status':
                await this.handleStatusUpdate(interaction);
                break;
        }
    }

    async handleCreateBridge(interaction) {
        const name = interaction.options.getString('name');
        const channel1 = await client.channels.fetch(interaction.options.getString('channel1'));
        const channel2 = await client.channels.fetch(interaction.options.getString('channel2'));

        if (!channel1.isTextBased() || !channel2.isTextBased()) {
            await interaction.reply({ content: '❌ Both channels must be text channels!', ephemeral: true });
            return;
        }

        const bridgeId = Date.now().toString();
        const bridgeData = {
            id: bridgeId,
            name: name,
            name_format: '{{USERNAME}} ({{GUILDNAME}})',
            channels: [`${channel1.id}`, `${channel2.id}`],
            blacklist_roles: []
        };

        try {
            saveBridge(bridgeId, bridgeData);
            bridges.push(bridgeData);
            await this.setupBridges();
            
            await interaction.reply({
                content: `✅ Bridge "${name}" created successfully!\nID: \`${bridgeId}\``,
                ephemeral: true
            });
        } catch (error) {
            log(`Failed to create bridge: ${error}`, 'DEV-CREATE');
            await interaction.reply({
                content: '❌ Failed to create bridge. Check console for details.',
                ephemeral: true
            });
        }
    }

    async handleEditBridge(interaction) {
        const bridgeId = interaction.options.getString('bridge_id');
        const bridge = loadBridge(bridgeId);

        if (!bridge) {
            await interaction.reply({
                content: '❌ Bridge not found!',
                ephemeral: true
            });
            return;
        }

        const newName = interaction.options.getString('name');
        const addChannel = interaction.options.getChannel('add_channel');
        const removeChannel = interaction.options.getChannel('remove_channel');

        if (newName) bridge.name = newName;

        if (addChannel) {
            if (!addChannel.isTextBased()) {
                await interaction.reply({
                    content: '❌ Can only add text channels!',
                    ephemeral: true
                });
                return;
            }
            if (!bridge.channels.includes(addChannel.id)) {
                bridge.channels.push(addChannel.id);
            }
        }

        if (removeChannel && bridge.channels.includes(removeChannel.id)) {
            bridge.channels = bridge.channels.filter(id => id !== removeChannel.id);
            if (bridge.channels.length < 2) {
                await interaction.reply({
                    content: '❌ Bridge must have at least 2 channels!',
                    ephemeral: true
                });
                return;
            }
        }

        try {
            saveBridge(bridgeId, bridge);
            // Update bridges array
            const index = bridges.findIndex(b => b.id === bridgeId);
            if (index !== -1) bridges[index] = bridge;
            await this.setupBridges();

            await interaction.reply({
                content: `✅ Bridge "${bridge.name}" updated successfully!`,
                ephemeral: true
            });
        } catch (error) {
            log(`Failed to edit bridge: ${error}`, 'DEV-EDIT');
            await interaction.reply({
                content: '❌ Failed to edit bridge. Check console for details.',
                ephemeral: true
            });
        }
    }

    async handleListBridges(interaction) {
        if (bridges.length === 0) {
            await interaction.reply({
                content: 'No bridges found!',
                ephemeral: true
            });
            return;
        }

        const bridgeList = bridges.map(bridge => {
            const channels = bridge.channels.map(id => `<#${id}>`).join(', ');
            return `**${bridge.name}** (ID: \`${bridge.id}\`)\nChannels: ${channels}`;
        }).join('\n\n');

        await interaction.reply({
            content: `**Bridge List**\n\n${bridgeList}`,
            ephemeral: true
        });
    }

    async handleDeleteBridge(interaction) {
        const bridgeId = interaction.options.getString('bridge_id');
        const bridgePath = path.join(BRIDGES_DIR, `${bridgeId}.json`);

        if (!fs.existsSync(bridgePath)) {
            await interaction.reply({
                content: '❌ Bridge not found!',
                ephemeral: true
            });
            return;
        }

        try {
            fs.unlinkSync(bridgePath);
            // Remove from bridges array
            const index = bridges.findIndex(b => b.id === bridgeId);
            if (index !== -1) bridges.splice(index, 1);
            await this.setupBridges();

            await interaction.reply({
                content: '✅ Bridge deleted successfully!',
                ephemeral: true
            });
        } catch (error) {
            log(`Failed to delete bridge: ${error}`, 'DEV-DELETE');
            await interaction.reply({
                content: '❌ Failed to delete bridge. Check console for details.',
                ephemeral: true
            });
        }
    }

    async handleStatusUpdate(interaction) {
        const type = interaction.options.getString('type');
        const text = interaction.options.getString('text');
        const url = interaction.options.getString('url');
        const status = interaction.options.getString('status');

        try {
            // Update presence
            const activityOptions = {
                type: ActivityType[type],
                name: text
            };

            if (type === 'Streaming' && !url) {
                await interaction.reply({
                    content: '❌ URL is required for Streaming activity!',
                    ephemeral: true
                });
                return;
            }

            if (url) activityOptions.url = url;

            const presenceData = {
                activities: [activityOptions]
            };

            if (status) {
                presenceData.status = status;
            }

            await this.client.user.setPresence(presenceData);

            await interaction.reply({
                content: `✅ Updated bot status:\nType: ${type}\nText: ${text}${url ? `\nURL: ${url}` : ''}${status ? `\nStatus: ${status}` : ''}`,
                ephemeral: true
            });
        } catch (error) {
            log(`Failed to update status: ${error}`, 'DEV-STATUS');
            await interaction.reply({
                content: '❌ Failed to update status. Check console for details.',
                ephemeral: true
            });
        }
    }
}

class NoRoleBypass {
    constructor(client) {
        this.client = client;
        this.client.on(Events.GuildMemberAdd, async (member) => await this.handleGuildMemberAdd(member));
        this.client.on(Events.GuildMemberRemove, async (member) => await this.handleGuildMemberRemove(member));
    }

    async handleGuildMemberAdd(member) {
        const previousRoles = await this.getPreviousRoles(member.id);
        if (!previousRoles) return;

        try {
            log(`Restoring roles for ${member.user.tag}`, 'NO-ROLE-BYPASS');
            previousRoles.forEach(async (roleId) => {
                const role = member.guild.roles.cache.get(roleId);
                if (role) {
                    await member.roles.add(role, "Role restore").catch(e=>{});
                }
            });
            this.removePreviousRoles(member.id);
        } catch (error) {
            log(`Failed to add roles to ${member.user.tag}: ${error}`, 'NO-ROLE-BYPASS');
        }
    }

    async handleGuildMemberRemove(member) {
        if (member.user.bot) return;
        log(`Storing roles for ${member.user.tag}`, 'NO-ROLE-BYPASS');
        this.storePreviousRoles(member.id, member.roles.cache);
    }

    storePreviousRoles(userId, roles) {
        db.serialize(() => {
            db.run(`INSERT OR REPLACE INTO previous_roles (user_id, roles) VALUES (?, ?)`, [userId, JSON.stringify(Array.from(roles.keys()))]);
        });
    }

    async getPreviousRoles(userId) {
        return new Promise((resolve, reject) => {
            db.get(`SELECT roles FROM previous_roles WHERE user_id = ?`, [userId], (error, row) => {
                if (error) {
                    log(`Failed to get previous roles for ${userId}: ${error}`, 'NO-ROLE-BYPASS');
                    return reject(error);
                }
                resolve(row ? JSON.parse(row.roles) : null);
            });
        });
    }    

    removePreviousRoles(userId) {
        db.run(`DELETE FROM previous_roles WHERE user_id = ?`, [userId], error => {
            if (error) {
                log(`Failed to remove previous roles for ${userId}: ${error}`, 'NO-ROLE-BYPASS');
            }
        });
    }
}

client.once('ready', () => {
    log(`Setting up bridges...`, 'CLIENT');
    new Bridge(client);
    log(`Setting up "no-role bypass"...`, 'CLIENT');
    new NoRoleBypass(client);
    log(`${client.user.tag} is ready!`, 'CLIENT');
    client.user.setActivity('🚽 skibidi', { type: ActivityType.Custom });
});

client.login(
    process.env.TOKEN
);

function log(message, from = 'GENERAL') {
    console.log(`[${from}] ${message}`);
}
