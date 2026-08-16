import styles from './dynamic.module.css';

declare const compact: boolean;
const key = compact ? 'one' : 'two';
styles[key];
