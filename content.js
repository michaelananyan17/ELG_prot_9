// Content script for text rewriting and summarization
let originalTexts = new Map();
let isRewritten = false;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'rewritePage') {
        rewritePageContent(request.apiKey, request.targetLevel)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
    
    if (request.action === 'summarizePage') {
        summarizePageContent(request.apiKey, request.targetLevel)
            .then(result => sendResponse(result))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
    
    if (request.action === 'resetPage') {
        resetPageContent();
        sendResponse({ success: true });
    }
    
    if (request.action === 'updateProgress') {
        sendResponse({ success: true });
    }
});

// ========== REWRITE PAGE FUNCTIONALITY ==========

// Main function to rewrite page content
async function rewritePageContent(apiKey, targetLevel) {
    try {
        // Store original texts if not already stored
        if (!isRewritten) {
            storeOriginalTexts();
        }
        
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 10 });
        
        // Process each text element
        await rewriteTextElements(targetLevel, apiKey);
        
        isRewritten = true;
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: 100 });
        
        return { success: true, elementsRewritten: originalTexts.size };
        
    } catch (error) {
        console.error('Content rewriting error:', error);
        return { success: false, error: error.message };
    }
}

// Simple sequential processing
async function rewriteTextElements(targetLevel, apiKey) {
    const totalElements = originalTexts.size;
    let processedElements = 0;
    
    for (let [index, item] of originalTexts) {
        const originalText = item.originalText;
        
        if (originalText.trim().length > 10) {
            try {
                const isTitle = item.element.tagName.match(/^H[1-6]$/i);
                const rewrittenText = await rewriteTextWithOpenAI(originalText, targetLevel, apiKey, isTitle);
                
                // Simple text replacement without complex layout changes
                replaceElementTextSimple(item.element, rewrittenText);
                
            } catch (error) {
                console.error(`Error rewriting element ${index}:`, error);
            }
        }
        
        processedElements++;
        const progress = 10 + Math.floor((processedElements / totalElements) * 80);
        chrome.runtime.sendMessage({ action: 'progressUpdate', progress: progress });
        
        // Small delay between elements
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

// Store original text content - FIXED: Better element selection
function storeOriginalTexts() {
    originalTexts.clear();
    
    // More selective element targeting to avoid random blocks
    const textElements = document.querySelectorAll(`
        p, h1, h2, h3, h4, h5, h6,
        article p, article h1, article h2, article h3,
        section p, section h1, section h2, section h3,
        .content p, .content h1, .content h2, .content h3,
        .article p, .article h1, .article h2, .article h3,
        .post p, .post h1, .post h2, .post h3,
        [role="article"] p, [role="article"] h1, [role="article"] h2,
        main p, main h1, main h2, main h3
    `);
    
    let index = 0;
    
    textElements.forEach((element) => {
        // More strict filtering to avoid random text blocks
        if (shouldProcessElementStrict(element) &&
            element.textContent && 
            element.textContent.trim().length > 25 && 
            isVisible(element) &&
            !isInNav(element) &&
            !isInteractive(element)) {
            
            // Skip elements that are likely to be meta content or random blocks
            if (isRandomTextBlock(element)) {
                return;
            }
            
            originalTexts.set(index, {
                element: element,
                originalText: element.textContent,
                originalHTML: element.innerHTML,
                tagName: element.tagName.toLowerCase()
            });
            index++;
        }
    });
    
    console.log(`Stored ${originalTexts.size} text elements for rewriting`);
}

// STRICT element filtering to avoid random blocks
function shouldProcessElementStrict(element) {
    const tagName = element.tagName.toLowerCase();
    const className = element.className.toLowerCase();
    const text = element.textContent.trim();
    
    // Don't process very short texts that might be UI elements
    if (text.length < 30 && !tagName.match(/^h[1-6]$/)) {
        return false;
    }
    
    // Don't process elements with certain classes
    const excludeClasses = ['meta', 'time', 'date', 'author', 'byline', 'caption', 'label'];
    for (const excludeClass of excludeClasses) {
        if (className.includes(excludeClass)) {
            return false;
        }
    }
    
    // Only process headings and paragraphs in main content areas
    if (tagName.match(/^h[1-6]$/) || tagName === 'p') {
        return isInMainContent(element);
    }
    
    return true;
}

// Check if element is in main content area
function isInMainContent(element) {
    const mainContentSelectors = [
        'main', 'article', '[role="main"]', '.content', '.main-content',
        '.post-content', '.article-content', '.story-content', '.entry-content'
    ];
    
    for (const selector of mainContentSelectors) {
        if (element.closest(selector)) {
            return true;
        }
    }
    
    // If no main content container found, check if it's in body directly
    // but not in header, footer, nav, etc.
    const nonContentContainers = ['header', 'footer', 'nav', 'aside', '.header', '.footer', '.nav', '.sidebar'];
    for (const container of nonContentContainers) {
        if (element.closest(container)) {
            return false;
        }
    }
    
    return true;
}

// Detect random text blocks
function isRandomTextBlock(element) {
    const text = element.textContent.trim();
    
    // Skip elements that are too short and not headings
    if (text.length < 40 && !element.tagName.match(/^H[1-6]$/i)) {
        return true;
    }
    
    // Skip elements that look like metadata, dates, author info
    const metaPatterns = [
        /\d{1,2}\/\d{1,2}\/\d{4}/, // dates
        /^(by|posted|published|updated):?/i, // author info
        /^\d+\s*(comments|shares|likes)$/i, // social counts
        /^[A-Z][a-z]+day,\s+[A-Z][a-z]+\s+\d{1,2}/i // full dates
    ];
    
    for (const pattern of metaPatterns) {
        if (pattern.test(text)) {
            return true;
        }
    }
    
    return false;
}

// SIMPLE text replacement without layout changes
function replaceElementTextSimple(element, newText) {
    const childElements = Array.from(element.children);
    
    // For elements with children, preserve structure but replace text
    if (childElements.length > 0) {
        const textNodes = getTextNodes(element);
        
        // Remove only the main text nodes, preserve child elements
        textNodes.forEach(node => {
            if (node.parentNode === element) { // Only direct text children
                node.parentNode.removeChild(node);
            }
        });
        
        // Add new text at the beginning
        const newTextNode = document.createTextNode(newText);
        if (element.firstChild) {
            element.insertBefore(newTextNode, element.firstChild);
        } else {
            element.appendChild(newTextNode);
        }
    } else {
        // Simple elements just replace text
        element.textContent = newText;
    }
    
    // Minimal visual feedback
    element.style.transition = 'opacity 0.2s ease';
    element.style.opacity = '0.9';
    setTimeout(() => {
        element.style.opacity = '1';
    }, 100);
}

// UPDATED: Text rewriting with better title handling
async function rewriteTextWithOpenAI(text, targetLevel, apiKey, isTitle = false) {
    const cleanText = text.trim().replace(/\s+/g, ' ').substring(0, 2000);
    
    const temperature = getTemperatureForLevel(targetLevel);
    
    // SIMPLIFIED: Different approach for titles vs regular text
    let prompt;
    
    if (isTitle) {
        prompt = `Rewrite this title to CEFR level ${targetLevel} English. Keep it SHORT, CLEAR and INFORMATIVE. Preserve the core meaning and key information. Do not make it longer or add unnecessary words.

Original: "${cleanText}"
Rewritten:`;
    } else {
        const levelInstructions = getEnhancedLevelInstructions(targetLevel);
        
        prompt = `Rewrite this text to CEFR level ${targetLevel} English. ${levelInstructions} Keep the same meaning and preserve names, dates, numbers, and technical terms exactly.

Text: "${cleanText}"
Rewritten:`;
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: isTitle ? 
                            'You rewrite titles to specific English levels while keeping them short, clear and informative.' :
                            'You rewrite text to specific CEFR English levels while preserving the original meaning and specific terms.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: Math.min(2000, cleanText.length * 2),
                temperature: temperature
            })
        });
        
        if (!response.ok) {
            throw new Error('API request failed');
        }
        
        const data = await response.json();
        const rewrittenText = data.choices[0].message.content.trim();
        
        return rewrittenText || text;
        
    } catch (error) {
        console.error('OpenAI API Error:', error);
        return text;
    }
}

// ========== SUMMARIZE PAGE FUNCTIONALITY ==========
// ... (keep the existing summarizePageContent, createSummary, downloadSummaryAsText functions unchanged)

// ========== UTILITY FUNCTIONS ==========

// Check if element is visible
function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && 
           style.visibility !== 'hidden' && 
           style.opacity !== '0' &&
           element.offsetWidth > 0 &&
           element.offsetHeight > 0;
}

// Check if element is in navigation
function isInNav(element) {
    return element.closest('nav, .nav, .navigation, .menu, header, .header, footer, .footer, aside, .sidebar');
}

// Check if element is interactive
function isInteractive(element) {
    return element.tagName === 'BUTTON' || 
           element.tagName === 'A' ||
           element.getAttribute('role') === 'button' ||
           element.onclick != null;
}

// Get temperature based on CEFR level
function getTemperatureForLevel(targetLevel) {
    const temperatureMap = {
        'A1': 0.3,
        'A2': 0.4,
        'B1': 0.5,
        'B2': 0.6,
        'C1': 0.75,
        'C2': 0.9
    };
    return temperatureMap[targetLevel] || 0.5;
}

// Get enhanced level-specific instructions
function getEnhancedLevelInstructions(targetLevel) {
    const instructions = {
        'A1': 'Use very simple words and short sentences.',
        'A2': 'Use basic everyday vocabulary and clear sentences.',
        'B1': 'Use straightforward language with some variety.',
        'B2': 'Use more complex sentences and vocabulary.',
        'C1': 'Use advanced vocabulary and complex structures.',
        'C2': 'Use sophisticated, native-level language.'
    };
    return instructions[targetLevel] || 'Use appropriate language for the level.';
}

// Get text nodes from an element
function getTextNodes(element) {
    const textNodes = [];
    
    function findTextNodes(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            textNodes.push(node);
        } else {
            node.childNodes.forEach(findTextNodes);
        }
    }
    
    findTextNodes(element);
    return textNodes;
}

// Reset page to original content
function resetPageContent() {
    if (!isRewritten) return;
    
    originalTexts.forEach(item => {
        item.element.innerHTML = item.originalHTML;
    });
    
    isRewritten = false;
}

// Extract main content from the page
function extractMainContent() {
    // ... (keep existing extractMainContent function)
}

// Clean text content
function cleanTextContent(text) {
    // ... (keep existing cleanTextContent function)
}