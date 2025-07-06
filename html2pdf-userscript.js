// ==UserScript==
// @name         HTML2PDF 网页元素转PDF
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  在任意网站添加按钮，选择页面元素并生成PDF
// @author       You
// @match        *://*/*
// @grant        none
// @require      file:///D:/project-code/html2pdf/dist/html2pdf.js
// @require      file:///D:/project-code/html2pdf/examples/SourceHanSansSC-Normal-Min-normal.js
// ==/UserScript==

(function () {
    'use strict';

    // 全局变量
    let isSelecting = false;
    let selectedElement = null;
    let overlay = null;
    let controlPanel = null;

    // 创建控制面板
    function createControlPanel() {
        const panel = document.createElement('div');
        panel.id = 'html2pdf-control-panel';
        panel.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            font-family: 'Arial', sans-serif;
            transition: all 0.3s ease;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
        `;

        // 创建主面板内容（默认隐藏）
        const panelContent = document.createElement('div');
        panelContent.id = 'html2pdf-panel-content';
        panelContent.style.cssText = `
            background: linear-gradient(145deg, #0F1C2E, #1E2A45);
            border: 1px solid #3A86FF;
            border-radius: 10px;
            padding: 15px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4), 0 0 15px rgba(58, 134, 255, 0.4);
            color: #e1e1e1;
            min-width: 220px;
            display: none;
            backdrop-filter: blur(5px);
            margin-top: 10px;
        `;

        panelContent.innerHTML = `
            <div style="
                margin-bottom: 15px; 
                font-weight: bold; 
                color: #5EEAD4; 
                font-size: 16px;
                display: flex;
                align-items: center;
                justify-content: space-between;
            ">
                <span>HTML2PDF 工具</span>
                <div style="
                    width: 40px;
                    height: 4px;
                    background: linear-gradient(90deg, #5EEAD4, #3A86FF);
                    border-radius: 2px;
                    box-shadow: 0 0 8px rgba(94, 234, 212, 0.6);
                "></div>
            </div>
            <button id="select-element-btn" style="
                width: 100%;
                padding: 8px 12px;
                margin-bottom: 10px;
                background: linear-gradient(90deg, #3A86FF, #5E60CE);
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                box-shadow: 0 2px 10px rgba(58, 134, 255, 0.4);
                transition: all 0.2s ease;
            ">选择元素</button>
            <button id="generate-pdf-btn" style="
                width: 100%;
                padding: 8px 12px;
                margin-bottom: 10px;
                background: linear-gradient(90deg, #5EEAD4, #38BDF8);
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                box-shadow: 0 2px 10px rgba(94, 234, 212, 0.4);
                opacity: 0.5;
                transition: all 0.2s ease;
                margin-left:0;
                text-shadow: 0 1px 2px rgba(0,0,0,0.3);
            " disabled>生成PDF</button>
            <button id="close-panel-btn" style="
                width: 100%;
                padding: 6px 12px;
                background: linear-gradient(90deg, #F72585, #7209B7);
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                box-shadow: 0 2px 10px rgba(247, 37, 133, 0.4);
                transition: all 0.2s ease;
                margin-left: 0;
                text-shadow: 0 1px 2px rgba(0,0,0,0.3);
            ">关闭</button>
            <div id="selected-info" style="
                margin-top: 10px;
                padding: 10px;
                background: rgba(14, 23, 38, 0.6);
                border-radius: 6px;
                font-size: 12px;
                color: #e1e1e1;
                display: none;
                border-left: 3px solid #5EEAD4;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2) inset;
            "></div>
        `;

        // 创建触发按钮（默认显示）
        const triggerButton = document.createElement('div');
        triggerButton.id = 'html2pdf-trigger-button';
        triggerButton.style.cssText = `
            width: 50px;
            height: 50px;
            border-radius: 50%;
            background: linear-gradient(145deg, #3A86FF, #5E60CE);
            box-shadow: 0 4px 15px rgba(58, 134, 255, 0.5), 0 0 20px rgba(58, 134, 255, 0.3);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        `;

        // 添加PDF图标
        triggerButton.innerHTML = `
            <div style="
                color: white;
                font-size: 20px;
                font-weight: bold;
                text-shadow: 0 1px 2px rgba(0,0,0,0.3);
            ">PDF</div>
            <div style="
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                border: 2px solid rgba(94, 234, 212, 0.4);
                animation: pulse 2s infinite;
            "></div>
        `;

        // 添加脉冲动画样式
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse {
                0% {
                    transform: scale(1);
                    opacity: 0.8;
                }
                70% {
                    transform: scale(1.1);
                    opacity: 0;
                }
                100% {
                    transform: scale(1);
                    opacity: 0;
                }
            }
            #select-element-btn:hover, #generate-pdf-btn:not([disabled]):hover, #close-panel-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 15px rgba(0,0,0,0.3);
                filter: brightness(1.1);
            }
            #html2pdf-trigger-button:hover {
                transform: scale(1.05);
                box-shadow: 0 4px 20px rgba(58, 134, 255, 0.6), 0 0 30px rgba(58, 134, 255, 0.4);
            }
            .html2pdf-highlight {
                outline: 3px solid #5EEAD4 !important;
                outline-offset: 2px !important;
                box-shadow: 0 0 15px rgba(94, 234, 212, 0.4) !important;
            }
        `;
        document.head.appendChild(style);

        // 将触发按钮和面板内容添加到主面板
        panel.appendChild(triggerButton);
        panel.appendChild(panelContent);
        document.body.appendChild(panel);

        // 添加触发按钮点击事件
        triggerButton.addEventListener('click', () => {
            const content = document.getElementById('html2pdf-panel-content');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                triggerButton.style.transform = 'scale(0.9)';
            } else {
                content.style.display = 'none';
                triggerButton.style.transform = 'scale(1)';
            }
        });

        return panel;
    }

    // 创建选择覆盖层
    function createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'html2pdf-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 123, 186, 0.1);
            z-index: 9999;
            cursor: crosshair;
            pointer-events: none;
        `;
        document.body.appendChild(overlay);
        return overlay;
    }

    // 高亮元素
    function highlightElement(element) {
        // 移除之前的高亮
        const prevHighlight = document.querySelector('.html2pdf-highlight');
        if (prevHighlight) {
            prevHighlight.classList.remove('html2pdf-highlight');
        }

        // 添加高亮样式
        if (element && element !== document.body) {
            element.classList.add('html2pdf-highlight');

            // 添加高亮CSS
            if (!document.querySelector('#html2pdf-highlight-style')) {
                const style = document.createElement('style');
                style.id = 'html2pdf-highlight-style';
                // style.textContent = `
                //     .html2pdf-highlight {
                //         outline: 3px solid #007cba !important;
                //         outline-offset: 2px !important;
                //     }
                // `;
                document.head.appendChild(style);
            }
        }
    }

        // 高亮元素
    function highlightElement(element) {
        // 移除之前的高亮
        const prevHighlight = document.querySelector('.html2pdf-highlight');
        if (prevHighlight) {
            prevHighlight.classList.remove('html2pdf-highlight');
        }

        // 添加高亮样式
        if (element && element !== document.body) {
            element.classList.add('html2pdf-highlight');

            // 添加高亮CSS
            if (!document.querySelector('#html2pdf-highlight-style')) {
                const style = document.createElement('style');
                style.id = 'html2pdf-highlight-style';
                style.textContent = `
                    .html2pdf-highlight {
                        outline: 3px solid #007cba !important;
                        outline-offset: 2px !important;

                    }
                `;
                document.head.appendChild(style);
            }
        }
    }

    // 开始选择模式
    function startSelection() {
        isSelecting = true;
        overlay = createOverlay();
        document.body.style.cursor = 'crosshair';

        // 更新按钮状态
        const selectBtn = document.getElementById('select-element-btn');
        selectBtn.textContent = '取消选择';
        selectBtn.style.background = '#dc3545';

        // 添加事件监听
        document.addEventListener('mouseover', onMouseOver);
        document.addEventListener('click', onElementClick);
        document.addEventListener('keydown', onKeyDown);
    }

    // 停止选择模式
    function stopSelection() {
        isSelecting = false;
        document.body.style.cursor = '';

        if (overlay) {
            overlay.remove();
            overlay = null;
        }

        // 更新按钮状态
        const selectBtn = document.getElementById('select-element-btn');
        selectBtn.textContent = '选择元素';
        selectBtn.style.background = 'linear-gradient(90deg, #4cc9f0, #4361ee)';

        // 移除事件监听
        document.removeEventListener('mouseover', onMouseOver);
        document.removeEventListener('click', onElementClick);
        document.removeEventListener('keydown', onKeyDown);
    }

    // 鼠标悬停事件
    function onMouseOver(e) {
        if (!isSelecting) return;
        e.preventDefault();

        const element = e.target;
        if (element !== controlPanel && !controlPanel.contains(element)) {
            highlightElement(element);
        }
    }

    // 元素点击事件
    function onElementClick(e) {
        if (!isSelecting) return;
        e.preventDefault();
        e.stopPropagation();

        const element = e.target;
        if (element !== controlPanel && !controlPanel.contains(element)) {
            selectedElement = element;
            stopSelection();
            updateSelectedInfo(element);
            enablePdfGeneration();
        }
    }

    // 键盘事件（ESC取消选择）
    function onKeyDown(e) {
        if (e.key === 'Escape' && isSelecting) {
            stopSelection();
        }
    }

    // 更新选中元素信息
    function updateSelectedInfo(element) {
        const info = document.getElementById('selected-info');
        const tagName = element.tagName.toLowerCase();
        const className = element.className ? `.${element.className.split(' ').join('.')}` : '';
        const id = element.id ? `#${element.id}` : '';

        // info.innerHTML = `
        //     <strong>已选择元素:</strong><br>
        //     标签: ${tagName}${id}${className}<br>
        //     尺寸: ${element.offsetWidth} × ${element.offsetHeight}px
        //     ${element.parentElement && element.parentElement !== document.body ? 
        //         `<button id="select-parent-btn" style="
        //             margin-top: 8px;
        //             padding: 4px 8px;
        //             background: linear-gradient(90deg, #5E60CE, #7209B7);
        //             color: white;
        //             border: none;
        //             border-radius: 4px;
        //             cursor: pointer;
        //             font-size: 12px;
        //             box-shadow: 0 2px 6px rgba(94, 96, 206, 0.4);
        //             transition: all 0.2s ease;
        //             display: block;
        //             width: 100%;
        //         ">选择父元素</button>` : 
        //         ''
        //     }
        // `;
        info.style.display = 'block';

        // 如果有父元素且不是body，添加选择父元素按钮事件
        // if (element.parentElement && element.parentElement !== document.body) {
        //     document.getElementById('select-parent-btn').addEventListener('click', () => {
        //         selectParentElement(element);
        //     });
        // }
    }

    // 选择父元素
    // function selectParentElement(element) {
    //     if (element && element.parentElement && element.parentElement !== document.body) {
    //         // 更新选中元素为父元素
    //         selectedElement = element.parentElement;

    //         // 高亮显示父元素
    //         highlightElement(selectedElement);

    //         // 更新选中信息
    //         updateSelectedInfo(selectedElement);
    //     }
    // }

    // 启用PDF生成按钮
    function enablePdfGeneration() {
        const pdfBtn = document.getElementById('generate-pdf-btn');
        pdfBtn.disabled = false;
        pdfBtn.style.opacity = '1';
    }

    // 生成PDF
    async function generatePDF() {
        if (!selectedElement) {
            alert('请先选择要转换的元素');
            return;
        }

        try {
            // 显示加载状态
            const pdfBtn = document.getElementById('generate-pdf-btn');
            const originalText = pdfBtn.textContent;
            pdfBtn.textContent = '生成中...';
            pdfBtn.disabled = true;

            // 使用html2canvas截图
            html2pdf(selectedElement, {
                useCORS: true,
                scale: 1,
                fontConfig: {
                    fontFamily: 'SourceHanSansCN-Medium',
                    fontBase64: window.fontBase64, //
                    fontUrl: '',
                    fontWeight: 400,
                    fontStyle: 'normal'
                },
            }).then(function (canvas) {
                const link = document.createElement('a');
                link.download = 'output.png';
                link.href = canvas.toDataURL('image/png');
                link.click();
                // 恢复按钮状态
                pdfBtn.textContent = originalText;
                pdfBtn.disabled = false;

                alert('PDF生成成功！');
            }).catch(function (err) {
                console.log('creacterr', err);

            });;





        } catch (error) {
            console.error('PDF生成失败:', error);
            alert('PDF生成失败，请检查控制台错误信息');

            // 恢复按钮状态
            const pdfBtn = document.getElementById('generate-pdf-btn');
            pdfBtn.textContent = '生成PDF';
            pdfBtn.disabled = false;
        }
    }


    // 关闭面板
    function closePanel() {
        if (isSelecting) {
            stopSelection();
        }

        // 移除高亮
        const highlight = document.querySelector('.html2pdf-highlight');
        if (highlight) {
            highlight.classList.remove('html2pdf-highlight');
        }

        // 移除样式
        const style = document.querySelector('#html2pdf-highlight-style');
        if (style) {
            style.remove();
        }

        // 移除面板
        if (controlPanel) {
            controlPanel.remove();
            controlPanel = null;
        }

        selectedElement = null;
    }

    // 初始化
    function init() {
        // 等待页面加载完成
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
            return;
        }

        // 创建控制面板
        controlPanel = createControlPanel();

        // 绑定事件
        document.getElementById('select-element-btn').addEventListener('click', () => {
            if (isSelecting) {
                stopSelection();
            } else {
                startSelection();
            }
        });

        document.getElementById('generate-pdf-btn').addEventListener('click', generatePDF);
        document.getElementById('close-panel-btn').addEventListener('click', closePanel);

        // 让面板可拖拽
        let isDragging = false;
        let dragOffset = {
            x: 0,
            y: 0
        };

        controlPanel.addEventListener('mousedown', (e) => {
            if (e.target.tagName !== 'BUTTON') {
                isDragging = true;
                dragOffset.x = e.clientX - controlPanel.offsetLeft;
                dragOffset.y = e.clientY - controlPanel.offsetTop;
                controlPanel.style.cursor = 'move';
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                controlPanel.style.left = (e.clientX - dragOffset.x) + 'px';
                controlPanel.style.top = (e.clientY - dragOffset.y) + 'px';
                controlPanel.style.right = 'auto';
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            controlPanel.style.cursor = '';
        });

        console.log('HTML2PDF 用户脚本已加载');
    }

    // 启动脚本
    init();

})();



// (function () {
//     'use strict';

//     // 全局变量
//     let isSelecting = false;
//     let selectedElement = null;
//     let overlay = null;
//     let controlPanel = null;

//     // 创建控制面板
//     function createControlPanel() {
//         const panel = document.createElement('div');
//         panel.id = 'dompdf-control-panel';
//         panel.style.cssText = `
//             position: fixed;
//             top: 20px;
//             right: 20px;
//             z-index: 10000;
//             background: #fff;
//             border: 2px solid #007cba;
//             border-radius: 8px;
//             padding: 15px;
//             box-shadow: 0 4px 12px rgba(0,0,0,0.15);
//             font-family: Arial, sans-serif;
//             min-width: 200px;
//         `;

//         panel.innerHTML = `
//             <div style="margin-bottom: 10px; font-weight: bold; color: #333;">dompdf 工具</div>
//             <button id="select-element-btn" style="
//                 width: 100%;
//                 padding: 8px 12px;
//                 margin-bottom: 8px;
//                 background: #007cba;
//                 color: white;
//                 border: none;
//                 border-radius: 4px;
//                 cursor: pointer;
//                 font-size: 14px;
//             ">选择元素</button>
//             <button id="generate-pdf-btn" style="
//                 width: 100%;
//                 padding: 8px 12px;
//                 margin-bottom: 8px;
//                 background: #28a745;
//                 color: white;
//                 border: none;
//                 border-radius: 4px;
//                 cursor: pointer;
//                 font-size: 14px;
//                 opacity: 0.5;
//                 margin-left:0
//             " disabled>生成PDF</button>
//             <button id="close-panel-btn" style="
//                 width: 100%;
//                 padding: 6px 12px;
//                 background: #dc3545;
//                 color: white;
//                 border: none;
//                 border-radius: 4px;
//                 cursor: pointer;
//                 font-size: 12px;
//                 margin - left: 0
//             ">关闭</button>
//             <div id="selected-info" style="
//                 margin-top: 10px;
//                 padding: 8px;
//                 background: #f8f9fa;
//                 border-radius: 4px;
//                 font-size: 12px;
//                 color: #666;
//                 display: none;
//             "></div>
//         `;

//         document.body.appendChild(panel);
//         return panel;
//     }

//     // 创建选择覆盖层
//     function createOverlay() {
//         const overlay = document.createElement('div');
//         overlay.id = 'dompdf-overlay';
//         overlay.style.cssText = `
//             position: fixed;
//             top: 0;
//             left: 0;
//             width: 100%;
//             height: 100%;
//             background: rgba(0, 123, 186, 0.1);
//             z-index: 9999;
//             cursor: crosshair;
//             pointer-events: none;
//         `;
//         document.body.appendChild(overlay);
//         return overlay;
//     }

//     // 高亮元素
//     function highlightElement(element) {
//         // 移除之前的高亮
//         const prevHighlight = document.querySelector('.dompdf-highlight');
//         if (prevHighlight) {
//             prevHighlight.classList.remove('dompdf-highlight');
//         }

//         // 添加高亮样式
//         if (element && element !== document.body) {
//             element.classList.add('dompdf-highlight');

//             // 添加高亮CSS
//             if (!document.querySelector('#dompdf-highlight-style')) {
//                 const style = document.createElement('style');
//                 style.id = 'dompdf-highlight-style';
//                 style.textContent = `
//                     .dompdf-highlight {
//                         outline: 3px solid #007cba !important;
//                         outline-offset: 2px !important;

//                     }
//                 `;
//                 document.head.appendChild(style);
//             }
//         }
//     }

//     // 开始选择模式
//     function startSelection() {
//         isSelecting = true;
//         overlay = createOverlay();
//         document.body.style.cursor = 'crosshair';

//         // 更新按钮状态
//         const selectBtn = document.getElementById('select-element-btn');
//         selectBtn.textContent = '取消选择';
//         selectBtn.style.background = '#dc3545';

//         // 添加事件监听
//         document.addEventListener('mouseover', onMouseOver);
//         document.addEventListener('click', onElementClick);
//         document.addEventListener('keydown', onKeyDown);
//     }

//     // 停止选择模式
//     function stopSelection() {
//         isSelecting = false;
//         document.body.style.cursor = '';

//         if (overlay) {
//             overlay.remove();
//             overlay = null;
//         }

//         // 更新按钮状态
//         const selectBtn = document.getElementById('select-element-btn');
//         selectBtn.textContent = '选择元素';
//         selectBtn.style.background = '#007cba';

//         // 移除事件监听
//         document.removeEventListener('mouseover', onMouseOver);
//         document.removeEventListener('click', onElementClick);
//         document.removeEventListener('keydown', onKeyDown);
//     }

//     // 鼠标悬停事件
//     function onMouseOver(e) {
//         if (!isSelecting) return;
//         e.preventDefault();

//         const element = e.target;
//         if (element !== controlPanel && !controlPanel.contains(element)) {
//             highlightElement(element);
//         }
//     }

//     // 元素点击事件
//     function onElementClick(e) {
//         if (!isSelecting) return;
//         e.preventDefault();
//         e.stopPropagation();

//         const element = e.target;
//         if (element !== controlPanel && !controlPanel.contains(element)) {
//             selectedElement = element;
//             stopSelection();
//             updateSelectedInfo(element);
//             enablePdfGeneration();
//         }
//     }

//     // 键盘事件（ESC取消选择）
//     function onKeyDown(e) {
//         if (e.key === 'Escape' && isSelecting) {
//             stopSelection();
//         }
//     }

//     // 更新选中元素信息
//     function updateSelectedInfo(element) {
//         const info = document.getElementById('selected-info');
//         const tagName = element.tagName.toLowerCase();
//         const className = element.className ? `.${element.className.split(' ').join('.')}` : '';
//         const id = element.id ? `#${element.id}` : '';

//         info.innerHTML = `
//             <strong>已选择元素:</strong><br>
//             标签: ${tagName}${id}${className}<br>
//             尺寸: ${element.offsetWidth} × ${element.offsetHeight}px
//         `;
//         info.style.display = 'block';
//     }

//     // 启用PDF生成按钮
//     function enablePdfGeneration() {
//         const pdfBtn = document.getElementById('generate-pdf-btn');
//         pdfBtn.disabled = false;
//         pdfBtn.style.opacity = '1';
//     }

//     // 生成PDF
//     async function generatePDF() {
//         if (!selectedElement) {
//             alert('请先选择要转换的元素');
//             return;
//         }

//         try {
//             // 显示加载状态
//             const pdfBtn = document.getElementById('generate-pdf-btn');
//             const originalText = pdfBtn.textContent;
//             pdfBtn.textContent = '生成中...';
//             pdfBtn.disabled = true;

//             // 使用html2canvas截图
//             dompdf(selectedElement, {
//                 useCORS: true,
//                 scale: 1,
//                 fontConfig: {
//                     fontFamily: 'SourceHanSansCN-Medium',
//                     fontBase64: window.fontBase64, //
//                     fontUrl: '',
//                     fontWeight: 400,
//                     fontStyle: 'normal'
//                 },
//             }).then(function (blob) {
//                 const url = URL.createObjectURL(blob);
//                 const a = document.createElement('a');
//                 a.href = url;
//                 a.download = "example.pdf";
//                 document.body.appendChild(a);
//                 a.click();

//                 // 清理
//                 setTimeout(() => {
//                     document.body.removeChild(a);
//                     URL.revokeObjectURL(url);
//                 }, 100);
//                 // 恢复按钮状态
//                 pdfBtn.textContent = originalText;
//                 pdfBtn.disabled = false;

//                 alert('PDF生成成功！');
//             }).catch(function (err) {
//                 console.log('creacterr', err);

//             });;





//         } catch (error) {
//             console.error('PDF生成失败:', error);
//             alert('PDF生成失败，请检查控制台错误信息');

//             // 恢复按钮状态
//             const pdfBtn = document.getElementById('generate-pdf-btn');
//             pdfBtn.textContent = '生成PDF';
//             pdfBtn.disabled = false;
//         }
//     }

//     // 关闭面板
//     function closePanel() {
//         if (isSelecting) {
//             stopSelection();
//         }

//         // 移除高亮
//         const highlight = document.querySelector('.dompdf-highlight');
//         if (highlight) {
//             highlight.classList.remove('dompdf-highlight');
//         }

//         // 移除样式
//         const style = document.querySelector('#dompdf-highlight-style');
//         if (style) {
//             style.remove();
//         }

//         // 移除面板
//         if (controlPanel) {
//             controlPanel.remove();
//             controlPanel = null;
//         }

//         selectedElement = null;
//     }

//     // 初始化
//     function init() {
//         // 等待页面加载完成
//         if (document.readyState === 'loading') {
//             document.addEventListener('DOMContentLoaded', init);
//             return;
//         }

//         // 创建控制面板
//         controlPanel = createControlPanel();

//         // 绑定事件
//         document.getElementById('select-element-btn').addEventListener('click', () => {
//             if (isSelecting) {
//                 stopSelection();
//             } else {
//                 startSelection();
//             }
//         });

//         document.getElementById('generate-pdf-btn').addEventListener('click', generatePDF);
//         document.getElementById('close-panel-btn').addEventListener('click', closePanel);

//         // 让面板可拖拽
//         let isDragging = false;
//         let dragOffset = {
//             x: 0,
//             y: 0
//         };

//         controlPanel.addEventListener('mousedown', (e) => {
//             if (e.target.tagName !== 'BUTTON') {
//                 isDragging = true;
//                 dragOffset.x = e.clientX - controlPanel.offsetLeft;
//                 dragOffset.y = e.clientY - controlPanel.offsetTop;
//                 controlPanel.style.cursor = 'move';
//             }
//         });

//         document.addEventListener('mousemove', (e) => {
//             if (isDragging) {
//                 controlPanel.style.left = (e.clientX - dragOffset.x) + 'px';
//                 controlPanel.style.top = (e.clientY - dragOffset.y) + 'px';
//                 controlPanel.style.right = 'auto';
//             }
//         });

//         document.addEventListener('mouseup', () => {
//             isDragging = false;
//             controlPanel.style.cursor = '';
//         });

//         console.log('dompdf 用户脚本已加载');
//     }

//     // 启动脚本
//     init();

// })();