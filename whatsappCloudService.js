const axios = require('axios');
const config = require('./config');

/**
 * WhatsApp Cloud API Service
 * Replaces Baileys with official WhatsApp Cloud API
 */

const GRAPH_API_VERSION = 'v18.0';
const GRAPH_API_URL = 'https://graph.instagram.com';

class WhatsAppCloudService {
    constructor(employeeId, accessToken, phoneNumberId, businessAccountId) {
        this.employeeId = employeeId;
        this.accessToken = accessToken;
        this.phoneNumberId = phoneNumberId;
        this.businessAccountId = businessAccountId;
        this.baseUrl = `${GRAPH_API_URL}/${GRAPH_API_VERSION}`;
    }

    /**
     * Send a text message
     */
    async sendTextMessage(recipientPhoneNumber, messageText) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/${this.phoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: recipientPhoneNumber,
                    type: 'text',
                    text: {
                        preview_url: false,
                        body: messageText
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return { success: true, messageId: response.data.messages[0].id };
        } catch (error) {
            console.error('❌ Failed to send text message:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send a media message (image, document, video, audio)
     */
    async sendMediaMessage(recipientPhoneNumber, mediaUrl, mediaType, caption = null) {
        try {
            const payload = {
                messaging_product: 'whatsapp',
                to: recipientPhoneNumber,
                type: mediaType,
                [mediaType]: {
                    link: mediaUrl
                }
            };

            if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
                payload[mediaType].caption = caption;
            }

            const response = await axios.post(
                `${this.baseUrl}/${this.phoneNumberId}/messages`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return { success: true, messageId: response.data.messages[0].id };
        } catch (error) {
            console.error('❌ Failed to send media message:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send a location message
     */
    async sendLocationMessage(recipientPhoneNumber, latitude, longitude, locationName = null) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/${this.phoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: recipientPhoneNumber,
                    type: 'location',
                    location: {
                        latitude,
                        longitude,
                        name: locationName || 'Location',
                        address: locationName || ''
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return { success: true, messageId: response.data.messages[0].id };
        } catch (error) {
            console.error('❌ Failed to send location message:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Send template message (useful for reports, confirmations, etc.)
     */
    async sendTemplateMessage(recipientPhoneNumber, templateName, templateLanguage = 'en', templateParams = []) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/${this.phoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: recipientPhoneNumber,
                    type: 'template',
                    template: {
                        name: templateName,
                        language: {
                            code: templateLanguage
                        },
                        parameters: {
                            body: {
                                parameters: templateParams
                            }
                        }
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return { success: true, messageId: response.data.messages[0].id };
        } catch (error) {
            console.error('❌ Failed to send template message:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Mark message as read
     */
    async markAsRead(messageId) {
        try {
            await axios.post(
                `${this.baseUrl}/${this.phoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    status: 'read',
                    message_id: messageId
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            return { success: true };
        } catch (error) {
            console.error('❌ Failed to mark message as read:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Download media from WhatsApp
     */
    async downloadMedia(mediaId) {
        try {
            // Get media URL
            const mediaResponse = await axios.get(
                `${this.baseUrl}/${mediaId}`,
                {
                    params: {
                        fields: 'url'
                    },
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                    }
                }
            );

            const mediaUrl = mediaResponse.data.url;

            // Download the actual media
            const downloadResponse = await axios.get(mediaUrl, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                },
                responseType: 'arraybuffer'
            });

            return downloadResponse.data;
        } catch (error) {
            console.error('❌ Failed to download media:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Get media URL from mediaId
     */
    async getMediaUrl(mediaId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/${mediaId}`,
                {
                    params: {
                        fields: 'url'
                    },
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`
                    }
                }
            );
            return response.data.url;
        } catch (error) {
            console.error('❌ Failed to get media URL:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Upload media for sending
     * Note: WhatsApp Cloud API has specific requirements for media
     */
    async uploadMedia(mediaBuffer, mimeType) {
        try {
            // For now, we'll return a note that media should be sent via URL
            // Or implement direct upload if needed
            console.log('📤 Media upload requested - ensure media is accessible via public URL');
            return { note: 'Use publicly accessible URLs for media' };
        } catch (error) {
            console.error('❌ Failed to upload media:', error.message);
            throw error;
        }
    }

    /**
     * Get contact info (name, status, etc.)
     */
    async getContactInfo(phoneNumber) {
        try {
            // WhatsApp Cloud API doesn't provide direct contact info retrieval
            // This would need to be handled through webhook data or stored in your database
            console.log(`ℹ️ Contact info for ${phoneNumber} should be retrieved from webhook context or database`);
            return { phoneNumber };
        } catch (error) {
            console.error('❌ Failed to get contact info:', error.message);
            throw error;
        }
    }

    /**
     * Verify webhook token (used during webhook setup)
     */
    static verifyWebhookToken(receivedToken, verifyToken) {
        return receivedToken === verifyToken;
    }

    /**
     * Verify webhook signature (ensures authenticity of incoming messages)
     */
    static verifyWebhookSignature(payload, signature, appSecret) {
        const crypto = require('crypto');
        const hash = crypto
            .createHmac('sha256', appSecret)
            .update(payload)
            .digest('hex');
        return `sha256=${hash}` === signature;
    }
}

module.exports = WhatsAppCloudService;
