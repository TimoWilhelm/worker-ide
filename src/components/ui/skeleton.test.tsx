import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
	AgentPanelSkeleton,
	DevelopmentToolsPanelSkeleton,
	EditorSkeleton,
	FileTreeSkeleton,
	GitPanelSkeleton,
	ListSkeleton,
	ModalContentSkeleton,
	OrganizationManagementSkeleton,
	OutputPanelSkeleton,
	PageContentSkeleton,
	PanelSkeleton,
	PreviewPanelSkeleton,
	SettingsContentSkeleton,
	Skeleton,
	WranglerSettingsSkeleton,
} from './skeleton';

describe('Skeleton', () => {
	it('renders a div with pulse animation', () => {
		const { container } = render(<Skeleton />);
		const element = container.firstChild;
		expect(element).toHaveClass('animate-pulse');
	});

	it('applies custom className', () => {
		const { container } = render(<Skeleton className="custom-skeleton" />);
		const element = container.firstChild;
		expect(element).toHaveClass('custom-skeleton');
	});

	it('passes through additional props', () => {
		const { container } = render(<Skeleton data-testid="test-skeleton" />);
		expect(container.querySelector('[data-testid="test-skeleton"]')).toBeInTheDocument();
	});
});

describe('FileTreeSkeleton', () => {
	it('renders multiple skeleton rows', () => {
		const { container } = render(<FileTreeSkeleton />);
		// Should render 8 rows, each with 2 skeleton elements
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(8);
	});
});

describe('EditorSkeleton', () => {
	it('renders multiple skeleton lines', () => {
		const { container } = render(<EditorSkeleton />);
		// Should render 12 skeleton lines
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons).toHaveLength(12);
	});
});

describe('PanelSkeleton', () => {
	it('renders without label', () => {
		const { container } = render(<PanelSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(1);
	});

	it('renders with label', () => {
		render(<PanelSkeleton label="Loading preview..." />);
		expect(screen.getByText('Loading preview...')).toBeInTheDocument();
	});
});

describe('GitPanelSkeleton', () => {
	it('renders multiple skeleton rows', () => {
		const { container } = render(<GitPanelSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(10);
	});
});

describe('ListSkeleton', () => {
	it('renders the requested number of list items', () => {
		const { container } = render(<ListSkeleton itemCount={3} />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(9);
	});
});

describe('ModalContentSkeleton', () => {
	it('renders structured modal placeholders', () => {
		const { container } = render(<ModalContentSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(6);
	});
});

describe('PreviewPanelSkeleton', () => {
	it('renders browser-like preview placeholders', () => {
		const { container } = render(<PreviewPanelSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(8);
	});
});

describe('DevelopmentToolsPanelSkeleton', () => {
	it('renders split-pane devtools placeholders', () => {
		const { container } = render(<DevelopmentToolsPanelSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(14);
	});
});

describe('AgentPanelSkeleton', () => {
	it('renders chat and composer placeholders', () => {
		const { container } = render(<AgentPanelSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(12);
	});
});

describe('OutputPanelSkeleton', () => {
	it('renders output log placeholders', () => {
		const { container } = render(<OutputPanelSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(10);
	});
});

describe('WranglerSettingsSkeleton', () => {
	it('renders settings-form placeholders', () => {
		const { container } = render(<WranglerSettingsSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(12);
	});
});

describe('OrganizationManagementSkeleton', () => {
	it('renders organization management placeholders', () => {
		const { container } = render(<OrganizationManagementSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(16);
	});
});

describe('PageContentSkeleton', () => {
	it('renders multiple skeleton elements', () => {
		const { container } = render(<PageContentSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(4);
	});
});

describe('SettingsContentSkeleton', () => {
	it('renders multiple skeleton elements', () => {
		const { container } = render(<SettingsContentSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(3);
	});
});
