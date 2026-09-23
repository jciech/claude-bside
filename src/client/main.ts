import { mount } from 'svelte';
import './ui/tokens.css';
import App from './ui/App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('missing #app');
mount(App, { target });
