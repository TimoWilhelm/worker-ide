import { Monitor, Moon, Sun } from 'lucide-react';

import { Modal, ModalBody } from '@/components/ui/modal';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { EDITOR_FONTS } from '@shared/constants';

import type { ComponentType } from 'react';

type ColorScheme = 'light' | 'dark' | 'system';

const THEME_OPTIONS: Array<{
	value: ColorScheme;
	label: string;
	icon: ComponentType<{ className?: string }>;
}> = [
	{ value: 'light', label: 'Light', icon: Sun },
	{ value: 'dark', label: 'Dark', icon: Moon },
	{ value: 'system', label: 'System', icon: Monitor },
];

function AppearanceContent() {
	const colorScheme = useStore((state) => state.colorScheme);
	const setColorScheme = useStore((state) => state.setColorScheme);
	const editorFont = useStore((state) => state.editorFont);
	const setEditorFont = useStore((state) => state.setEditorFont);

	return (
		<div className="flex flex-col gap-8">
			<section>
				<h2
					className="
						mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
					"
				>
					Theme
				</h2>
				<div className="grid grid-cols-3 gap-3">
					{THEME_OPTIONS.map((option) => {
						const isSelected = colorScheme === option.value;
						const Icon = option.icon;

						return (
							<button
								key={option.value}
								onClick={() => setColorScheme(option.value)}
								className={cn(
									`
										flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-4
										transition-colors
									`,
									isSelected
										? 'border-accent bg-accent/5 text-text-primary'
										: `
											border-border bg-bg-secondary/40 text-text-secondary
											hover:border-accent/50 hover:bg-bg-secondary/80
										`,
								)}
							>
								<Icon className={cn('size-5', isSelected && 'text-accent')} />
								<span className="text-xs font-medium">{option.label}</span>
							</button>
						);
					})}
				</div>
			</section>

			<section>
				<h2
					className="
						mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
					"
				>
					Editor Font
				</h2>
				<div className="grid grid-cols-2 gap-3">
					{EDITOR_FONTS.map((font) => {
						const isSelected = editorFont === font.slug;

						return (
							<button
								key={font.slug}
								onClick={() => setEditorFont(font.slug)}
								className={cn(
									`
										flex cursor-pointer flex-col items-center gap-3 rounded-lg border p-4
										transition-colors
									`,
									isSelected
										? 'border-accent bg-accent/5 text-text-primary'
										: `
											border-border bg-bg-secondary/40 text-text-secondary
											hover:border-accent/50 hover:bg-bg-secondary/80
										`,
								)}
							>
								<span className="text-lg leading-none" style={{ fontFamily: font.family }}>
									Aa
								</span>
								<span className="text-xs font-medium">{font.label}</span>
							</button>
						);
					})}
				</div>
			</section>
		</div>
	);
}

export function AppearanceModal() {
	const isOpen = useStore((state) => state.isAppearanceModalOpen);
	const setAppearanceModalOpen = useStore((state) => state.setAppearanceModalOpen);

	return (
		<Modal open={isOpen} onOpenChange={setAppearanceModalOpen} title="Appearance" className="w-[480px]">
			<ModalBody>
				<AppearanceContent />
			</ModalBody>
		</Modal>
	);
}
