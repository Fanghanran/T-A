# React 性能优化

## 避免不必要的渲染

React 默认在父组件渲染时会重新渲染子组件。使用 React.memo 包裹函数组件，对 props 做浅比较，跳过相等的重渲染。

useMemo 缓存昂贵的计算结果，useCallback 缓存回调函数引用，避免子组件因新函数引用而重渲染。

## 虚拟列表

渲染长列表时使用 react-window 或 react-virtualized，只渲染可视区域的元素，大幅降低 DOM 节点数量。

## 状态管理

将频繁更新的状态就近放置，避免顶层 state 抖动导致整棵树渲染。context 拆分按更新频率隔离。
